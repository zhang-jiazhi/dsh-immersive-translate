/**
 * @local/dsh-immersive-translate — host half.
 *
 * 把「沉浸式翻译」的核心能力搬进 DSH：抓网页 → 切正文块 → 用 DSH 自己的模型
 * 路由做块级翻译 → 双语对照呈现。
 *
 * 默认走沉浸式翻译自带的免费翻译服务（transmart / GLM 免费网关闭），
 * 不占用用户自己的模型额度；也可配置为借宿主的 `ctx.llm`，模型路由跟随
 * DSH 默认模型或本插件设置页显式指定的 provider/model。这一点是刻意的——
 * 扩展把用户引导到「开发者 → 自定义 AI 助手」去填第三方 key，而 DSH 里
 * 已经有一份配好的模型目录，插件没有理由再要一份凭据。
 *
 * 路由（loopback + same-origin 闸，与 dsh-prompt-optimizer 同口径）：
 *   GET  /api/dsh-immersive-translate/settings   → 当前生效配置 + 默认值
 *   POST /api/dsh-immersive-translate/settings   → 写入配置（落在 $DSH_HOME 下）
 *   POST /api/dsh-immersive-translate/fetch      → 抓取 URL 并抽取正文块
 *   POST /api/dsh-immersive-translate/translate  → 增量流式翻译（NDJSON）
 *   POST /api/dsh-immersive-translate/text       → 单段文本翻译（划词/短句）
 *
 * 工具：`translate_page`（抓取 + 双语，给模型读外文页面）、`translate_text`。
 * @module @dsh-external/dsh-immersive-translate
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractBlocks, extractTitle, resolveRule } from './extract.js'

/** Stable cordis plugin name. */
export const name = 'immersive-translate'

/**
 * 服务依赖。
 *
 * `llm` 是硬依赖（没有模型路由就没有翻译）；`webServer` 是硬依赖（设置页与
 * 流式翻译靠它）；`tools` 是硬依赖（本插件注册 translate_text / translate_page）。
 *
 * 三者都必须在 `inject` 里声明：cordis 的 Context 是属性代理，访问未声明服务的
 * 属性会直接抛 `cannot get property "x" without inject` 并让整个 fiber 回滚——
 * 症状是路由与工具一个都挂不上（2026-09-24 实测踩到）。`web` 与
 * `agentDefaultModel` 走 `ctx.get(...)` 软读取，宿主没有配置时降级而不是挂载失败。
 */
export const inject = ['webServer', 'tools']

/**
 * 宿主侧协议版本。
 *
 * 客户端会比对它来决定"当前跑的是新宿主还是旧宿主"：DSH 的宿主代码改动
 * **必须重启进程**才生效（模块已被 ESM 缓存），若客户端先于宿主更新，
 * 就会出现"界面是新版、翻译却仍走旧链路（用户的模型）"的静默错配。
 * 把版本带在 settings 响应里，客户端就能把这件事明确讲出来。
 */
export const HOST_PROTOCOL = 2

/** 单批送入模型的字符上限：太小则请求多，太大则单次失败重试代价高。 */
const BATCH_CHARS = 3500

/** 单个批次的条目上限（防止极短句产生几十条一个请求）。 */
const BATCH_ITEMS = 40

/** 一次页面翻译最多处理的块数（防御畸形页面把整机拖死）。 */
const MAX_BLOCKS = 500

/** 单次抓取的响应体上限（字符）。 */
const MAX_HTML_CHARS = 4_000_000

/** 划词/短句翻译的输入上限。 */
const MAX_TEXT_CHARS = 8000

/** 目标语言选项（设置页与面板共用）。 */
export const TARGET_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁体中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'ru', label: 'Русский' },
]

/** 内建默认配置（等同 schemastery 缺省值，供无 schemastery 环境回落）。 */
const DEFAULTS = {
  provider: '',
  model: '',
  targetLanguage: 'zh-CN',
  reasoningEffort: 'inherit',
  temperature: 0.2,
  maxTokens: 8192,
  timeoutMs: 120000,
  fetchMode: 'auto',
  userAgent: '',
  debug: false,
  // 默认“仅译文”：就地替换原文，鼠标悬停看原文（用户选定）。
  displayMode: 'translation',
  /**
   * 进入 DSH 后自动开始翻译。
   *
   * 这个键必须登记在 DEFAULTS 里：落盘走 `writeSettingsPatch`，它会按
   * `key in DEFAULTS` 白名单过滤，没登记的键会被静默丢弃（实测踩过：
   * 用户开了自动翻译，刷新后配置里根本没有这个键 → 功能"不生效"）。
   */
  autoTranslate: false,
  /** 是否显示悬浮球（关掉后可纯靠自动翻译工作，界面更干净）。 */
  showBall: true,
  // 翻译引擎：默认用沉浸式翻译自带的免费服务，不占用用户自己的模型额度。
  // auto（自带免费服务，按回退链）/ account（账号 Pro）/ 具体服务名（锁定它，不回退）
  // / dsh-model（借宿主模型，会花用户额度）
  engine: 'auto',
  freeService: 'auto',
  /**
   * 免费服务的并发批数。
   *
   * 实测（2026-09-25，transmart）：并发 2 → 8 批 7679ms；并发 4 → 4370ms；
   * 并发 6 → 3311ms；并发 10 → 2905ms，成功率均 8/8~30/30。取 4 作默认：
   * 相比串行/并发 2 有数倍提升，又与"偶发 busy"的距离足够安全（并发 4 时曾
   * 见到 1/8 次 `Server is busy`，所以下面必须有重试兜底）。
   */
  freeConcurrency: 4,
  useDshModel: false,
  allowModelFallback: false,
  accountToken: '',
  userRules: [],
  injectedCss: '',
  batchChars: BATCH_CHARS,
  maxBlocks: MAX_BLOCKS,
  /**
   * 默认并发 1（串行）。
   *
   * 若改用 `ctx.llm`，翻译会与 Agent 自己的请求**共用同一条模型路由**。默认并发 1
   * 时，一次大页翻译会同时占住 3 条模型调用，把用户正在进行的对话挤到后面
   * （2026-09-24 实测：MDN 页面翻到一半整个 DSH 会话明显卡住）。
   * 翻译是后台批量任务，让位给交互式请求才是正确的优先级；想加速的用户可在
   * 设置页把「并发请求数」调高——那是显式选择，而不是默认背着用户抢。
   */
  concurrency: 1,
}

/**
 * 配置落盘路径。
 * 放 `$DSH_HOME` 而不是插件目录：重装/换 git 检出不会丢用户设置。
 * @returns {string} 设置文件绝对路径。
 */
function settingsPath() {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'immersive-translate', 'settings.json')
}

/**
 * 原子写 JSON（临时文件 + rename），避免半截文件把设置读崩。
 * @param {string} file - 目标路径。
 * @param {unknown} value - 待写入的值。
 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * 读取落盘的设置。
 * @returns {Record<string, unknown>} 解析后的对象；不存在或损坏时返回空对象。
 */
function readSettingsFile() {
  const file = settingsPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 把若干已知字段合并进落盘设置（只读写磁盘，不碰内存状态）。
 *
 * 刻意不在这里改 `current`：那是 `apply()` 内的局部变量，模块级函数引用它会
 * 直接 ReferenceError（实测表现为"保存设置 500"）。内存刷新由调用方负责。
 * @param {Record<string, unknown>} patch - 待写入的已知字段。
 * @returns {Record<string, unknown>} 合并后的完整落盘内容。
 */
function writeSettingsPatch(patch) {
  const known = Object.fromEntries(Object.entries(patch).filter(([key]) => key in DEFAULTS))
  const merged = { ...readSettingsFile(), ...known }
  writeJsonAtomic(settingsPath(), merged)
  return merged
}

/**
 * 剪裁到合法范围。
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 缺省值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number} 合法数值。
 */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 归一化一份配置：缺字段补默认、越界值钳制、类型不符回落。
 *
 * 三处来源按优先级合并（后者覆盖前者）：内建默认 → profile 条目 config →
 * 设置页写下的 settings.json。设置页是用户直接操作的面，理当最高优先级。
 * @param {Record<string, unknown>} declared - profile patch 里声明的 config。
 * @param {Record<string, unknown>} stored - settings.json 的内容。
 * @returns {Record<string, unknown>} 生效配置。
 */
export function normalizeConfig(declared = {}, stored = {}) {
  const merged = { ...DEFAULTS, ...pickKnown(declared), ...pickKnown(stored) }
  const languages = new Set(TARGET_LANGUAGES.map((item) => item.id))
  return {
    ...merged,
    targetLanguage: languages.has(merged.targetLanguage) ? merged.targetLanguage : DEFAULTS.targetLanguage,
    temperature: typeof merged.temperature === 'number' && merged.temperature >= 0 && merged.temperature <= 2 ? merged.temperature : DEFAULTS.temperature,
    reasoningEffort: typeof merged.reasoningEffort === 'string' && merged.reasoningEffort !== '' ? merged.reasoningEffort : 'inherit',
    displayMode: merged.displayMode === 'translation' ? 'translation' : 'dual',
    fetchMode: ['auto', 'web', 'native'].includes(merged.fetchMode) ? merged.fetchMode : 'auto',
    maxTokens: clampNumber(merged.maxTokens, DEFAULTS.maxTokens, 64, 65536),
    timeoutMs: clampNumber(merged.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    batchChars: clampNumber(merged.batchChars, DEFAULTS.batchChars, 500, 12000),
    maxBlocks: clampNumber(merged.maxBlocks, DEFAULTS.maxBlocks, 20, 2000),
    concurrency: clampNumber(merged.concurrency, DEFAULTS.concurrency, 1, 6),
    // 免费服务并发：实测 4 是"提速明显 + 远离 busy"的平衡点，上限放到 8。
    freeConcurrency: clampNumber(merged.freeConcurrency, DEFAULTS.freeConcurrency, 1, 8),
    autoTranslate: merged.autoTranslate === true,
    showBall: merged.showBall !== false,
    userRules: Array.isArray(merged.userRules) ? merged.userRules.filter((rule) => rule !== null && typeof rule === 'object') : [],
    injectedCss: typeof merged.injectedCss === 'string' ? merged.injectedCss : '',
    userAgent: typeof merged.userAgent === 'string' ? merged.userAgent : '',
  }
}

/**
 * 只取已知字段：防止把前端塞进来的任意键写进合并结果。
 * @param {Record<string, unknown>} source - 候选对象。
 * @returns {Record<string, unknown>} 已知字段子集。
 */
function pickKnown(source) {
  if (source === null || typeof source !== 'object') return {}
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  return out
}

/** 默认 UA：不少站点对无 UA 的请求直接返回 403 或骨架页。 */
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 抓取一个 URL 的 HTML。
 *
 * 优先走宿主的 `ctx.web.fetch`（尊重部署里配置的抓取 provider 与代理），
 * 拿不到 provider 或 provider 失败时回落到原生 fetch。
 * @param {{ ctx: import('@deepseek-ai/cordis').Context, config: Record<string, unknown> }} deps - 上下文与配置。
 * @param {string} url - 目标 URL。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ url: string, html: string, status: number, via: string }>} 抓取结果。
 */
async function fetchHtml({ ctx, config }, url, signal) {
  const mode = config.fetchMode
  const web = mode === 'native' ? undefined : ctx.get('web')
  if (web !== undefined && typeof web.fetch === 'function') {
    try {
      const result = await web.fetch({ url }, signal)
      const body = result?.body
      const content = body?.kind === 'html' || body?.kind === 'text' ? body.content : undefined
      if (typeof content === 'string' && content !== '') {
        return { url: String(result.url ?? url), html: content.slice(0, MAX_HTML_CHARS), status: Number(result.statusCode ?? 200), via: 'web' }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[immersive-translate] web.fetch 失败，回落原生 fetch：${String(error?.message ?? error)}`)
    }
  }
  const headers = { 'user-agent': config.userAgent || DEFAULT_UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  const response = await fetch(url, { headers, redirect: 'follow', signal })
  const html = (await response.text()).slice(0, MAX_HTML_CHARS)
  return { url: response.url || url, html, status: response.status, via: 'native' }
}

/** 推理强度被拒绝时的判据（与 dsh-prompt-optimizer 同款自愈路径）。 */
function isUnsupportedEffortFailure(failure) {
  if (failure === null || failure === undefined) return false
  if (failure.code === 'UNSUPPORTED_REASONING_EFFORT') return true
  const message = typeof failure.message === 'string' ? failure.message : String(failure)
  return /reasoning effort/i.test(message) || /推理强度|不支持.{0,12}强度/.test(message)
}

/**
 * 解析模型返回的翻译数组。
 *
 * 模型经常裹一层 ```json 围栏，或有一两句前言；这里按"最外层方括号配对"
 * 抽 JSON，解析失败再退化为逐条目按 id 捞。永远不抛——解析失败由调用方
 * 决定降级（原文照留 + 报错），不能因为一次格式跑偏丢掉整页。
 * @param {string} raw - 模型输出。
 * @param {Array<{ id: string }>} expected - 本批提交的条目。
 * @returns {Map<string, string>} id → 译文。
 */
export function parseTranslations(raw, expected) {
  const out = new Map()
  const text = stripFence(String(raw ?? '')).trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item === null || typeof item !== 'object') continue
          const id = item.id ?? item.i ?? item.key
          const value = item.text ?? item.translation ?? item.value ?? item.target
          if (typeof value === 'string' && value.trim() !== '') out.set(String(id), value.trim())
        }
      }
    } catch {
      /* 落回逐条捞 */
    }
  }
  if (out.size === 0) {
    // 退化路径：模型改用 `id: 译文` 行格式时也能救回来。
    for (const line of text.split('\n')) {
      const match = /^\s*"?([\w-]+)"?\s*[:：]\s*(.+?)\s*$/.exec(line)
      if (match === null) continue
      out.set(match[1], match[2].replace(/^["']|["'],?$/g, '').trim())
    }
  }
  // 只保留本批真正提交过的 id，防止模型把上一批的内容串进来。
  const allowed = new Set(expected.map((item) => String(item.id)))
  for (const key of [...out.keys()]) if (!allowed.has(key)) out.delete(key)
  return out
}

/**
 * 剥掉整串包裹的代码围栏（内部围栏不动）。
 * @param {string} text - 模型输出。
 * @returns {string} 去掉外层围栏的文本。
 */
function stripFence(text) {
  const match = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return match === null ? text : match[1]
}

/** 翻译系统提示词：只做翻译，不做解释、不加料。 */
// ── 沉浸式翻译自带免费服务 ──────────────────────────────────────────────
//
// 这一层是"移植原插件的翻译能力"的核心：不再借 DSH 的模型路由，而是直接调用
// 沉浸式翻译扩展自己声明为免费的那几个服务。服务清单与端点提取自扩展的
// `default_config.json`（`translationServices`）与 `background.js`。

/**
 * 免费翻译服务定义。
 *
 * 每条都来自扩展内置配置，`provider` 标记它是否需要登录：
 *  - `free`  免登录公开端点（原扩展的 group:"free"）；
 *  - `oauth` 走沉浸式翻译账号（原扩展的 provider:"pro"）。
 */
export const FREE_SERVICES = {
  transmart: {
    id: 'transmart',
    implemented: true,
    label: '腾讯交互翻译（免费·免登录）',
    provider: 'free',
    // 原扩展 default_config.json: translationServices.transmart
    endpoint: 'https://transmart.qq.com/api/imt',
    // 实测（2026-09-25）：en→zh 与 zh→en 双向可用、免登录。
    // 单批上限是**服务端硬限制**：一次 60 条/约 4000 字符可过；
    // 100 条即返回 `outOfLimit: Too many characters (over 6000) in block`。
    // 故按 5000 字符留足余量（调用方按 charLimit 切批，超限会整批失败）。
    batchLimit: 60,
    charLimit: 5000,
  },
  bing: {
    id: 'bing',
    label: 'Bing 翻译（未实现）',
    provider: 'free',
    // 原扩展的默认服务。它的 ttranslatev3 需要每次请求现取页面里的
    // IG / key / token，实测复用令牌返回 statusCode 205；而扩展靠浏览器环境
    // 持续轮换才稳。这里先不实现，避免给用户一个"看着可选、点了就报错"的入口。
    endpoint: 'https://www.bing.com/ttranslatev3',
    implemented: false,
    batchLimit: 10,
    charLimit: 1000,
  },
  google: {
    id: 'google',
    implemented: true,
    label: 'Google 翻译（免费·免登录）',
    provider: 'free',
    endpoint: 'https://translate.googleapis.com/translate_a/single',
    batchLimit: 1,
    charLimit: 1800,
  },
  'zhipu-free': {
    id: 'zhipu-free',
    implemented: true,
    label: '智谱 GLM-4-Flash（免费·沉浸式翻译网关）',
    provider: 'gateway',
    // 原扩展 default_config.json: translationServices["zhipu-free"].apiUrl
    endpoint: 'https://aigw1.immersivetranslate.com/api/paas/v4/chat/completions',
    model: 'glm-4-flash-250414',
    batchLimit: 20,
    charLimit: 3000,
  },
}

/** 沉浸式翻译的语言代码映射（各家叫法不同）。 */
const LANG_CODES = {
  transmart: { 'zh-CN': 'zh', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru' },
  google: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru' },
  bing: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru' },
  'zhipu-free': { 'zh-CN': 'Chinese', 'zh-TW': 'Traditional Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian' },
}

/**
 * 把内部语言 id 翻成某服务认识的目标语言码。
 * @param {string} serviceId - 服务 id。
 * @param {string} language - 内部语言 id（如 `zh-CN`）。
 * @returns {string} 该服务的目标语言码。
 */
export function targetCodeFor(serviceId, language) {
  const table = LANG_CODES[serviceId] ?? LANG_CODES.transmart
  return table[language] ?? language
}

/** 源语言码（transmart 用 auto 自动识别）。 */
function sourceCodeFor(serviceId) {
  if (serviceId === 'transmart' || serviceId === 'zhipu-free') return 'auto'
  return 'auto'
}

/**
 * 调腾讯交互翻译（transmart）。
 *
 * 这是原扩展 group:"free" 里的服务，实测免登录、双向、可批量。
 * @param {object} options - { items, targetLanguage, signal, fetchImpl }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
async function translateViaTransmart({ items, targetLanguage, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch
  const target = targetCodeFor('transmart', targetLanguage)
  const response = await doFetch(FREE_SERVICES.transmart.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'https://transmart.qq.com/zh-CHS/index' },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0', device_type: 'web' },
      type: 'plain',
      source: { lang: sourceCodeFor('transmart'), text_list: items.map((item) => item.text) },
      target: { lang: target },
    }),
    signal,
  })
  if (!response.ok) throw new Error(`transmart HTTP ${String(response.status)}`)
  const payload = await response.json()
  const code = payload?.header?.ret_code
  if (code !== 'succ') throw new Error(`transmart 失败：${payload?.message ?? code ?? 'unknown'}`)
  const list = payload?.auto_translation
  if (!Array.isArray(list)) throw new Error('transmart 未返回译文数组')
  const map = new Map()
  items.forEach((item, index) => {
    const value = list[index]
    if (typeof value === 'string' && value !== '') map.set(item.id, value)
  })
  return map
}

/** 判断一个免费服务的失败是否值得重试（限流/服务繁忙/网络抖动）。 */
export function isRetryableServiceFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /busy/i.test(message)
    || /too many/i.test(message)
    || /HTTP (429|5\d\d)/.test(message)
    || /fetch failed|network|timeout|ECONN|socket/i.test(message)
}

/**
 * 带重试地调用一个免费服务。
 *
 * 必须有重试：实测并发 4 时 transmart 会偶发 `Server is busy now, (10000)`，
 * 旧实现遇到即整批失败 → 那部分内容**永远不会被翻译**（用户看到的"遗漏"）。
 * 退避重试能把这类瞬时失败吸收掉。
 * @param {object} options - { serviceId, items, targetLanguage, signal, fetchImpl, token, attempts }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
async function callFreeServiceWithRetry(options) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 3
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
    try {
      return await callFreeService(options)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isRetryableServiceFailure(error)) throw error
      // 指数退避 + 小抖动：避免同一时刻的多批请求一起重试再撞上限流。
      const wait = Math.round(300 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5))
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError ?? new Error('免费服务调用失败')
}

/**
 * 调 Google 免费端点（`translate_a/single`）。
 *
 * 原扩展的 google-free 走这条；只支持逐条，故调用方需按 batchLimit=1 分批。
 * @param {object} options - { items, targetLanguage, signal, fetchImpl }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
async function translateViaGoogle({ items, targetLanguage, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch
  const target = targetCodeFor('google', targetLanguage)
  const map = new Map()
  for (const item of items) {
    const url = `${FREE_SERVICES.google.endpoint}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(item.text)}`
    const response = await doFetch(url, { signal })
    if (!response.ok) throw new Error(`google HTTP ${String(response.status)}`)
    const payload = await response.json()
    const text = Array.isArray(payload?.[0]) ? payload[0].map((part) => part?.[0] ?? '').join('') : ''
    if (text !== '') map.set(item.id, text)
  }
  return map
}

/**
 * 调沉浸式翻译官方免费 AI 网关（zhipu-free / GLM-4-Flash）。
 *
 * 注意：该域名（aigw1.immersivetranslate.com）实测被 Cloudflare 拦成 403
 * `Just a moment...`，需要能通过挑战的网络环境。失败时由调用方回退到其它服务。
 * @param {object} options - { items, targetLanguage, signal, fetchImpl, token }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
async function translateViaZhipuFree({ items, targetLanguage, signal, fetchImpl, token }) {
  const doFetch = fetchImpl ?? fetch
  const target = targetCodeFor('zhipu-free', targetLanguage)
  const headers = { 'content-type': 'application/json' }
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  const response = await doFetch(FREE_SERVICES['zhipu-free'].endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: FREE_SERVICES['zhipu-free'].model,
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: `目标语言：${target}\n\n${JSON.stringify(items.map((item) => ({ id: item.id, text: item.text })))}` },
      ],
      temperature: 0.2,
      stream: false,
    }),
    signal,
  })
  if (!response.ok) throw new Error(`官方免费网关 HTTP ${String(response.status)}`)
  const payload = await response.json()
  const out = payload?.choices?.[0]?.message?.content
  if (typeof out !== 'string') throw new Error('官方免费网关未返回内容')
  return parseTranslations(out, items)
}

/**
 * 按服务分发一次翻译。
 * @param {object} options - { serviceId, items, targetLanguage, signal, fetchImpl, token }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
export async function callFreeService({ serviceId, items, targetLanguage, signal, fetchImpl, token }) {
  if (FREE_SERVICES[serviceId]?.implemented === false) {
    throw new Error(`该服务尚未实现：${serviceId}`)
  }
  if (serviceId === 'transmart') return translateViaTransmart({ items, targetLanguage, signal, fetchImpl })
  if (serviceId === 'google') return translateViaGoogle({ items, targetLanguage, signal, fetchImpl })
  if (serviceId === 'zhipu-free') return translateViaZhipuFree({ items, targetLanguage, signal, fetchImpl, token })
  if (serviceId === 'account') return translateViaAccount({ items, targetLanguage, token, signal, fetchImpl })
  throw new Error(`不支持的免费服务：${serviceId}`)
}

const TRANSLATE_SYSTEM = [
  '你是专业的网页翻译引擎。把用户给出的 JSON 数组里每个对象的 text 字段翻译成指定目标语言。',
  '规则：',
  '1. 只输出 JSON 数组，结构与输入完全一致，id 原样保留，不加任何解释或 Markdown 围栏。',
  '2. 逐项独立翻译，不合并、不拆分、不增删条目。',
  '3. 保留原文里的数字、代码、URL、专有名词与变量名；术语在同一批内保持一致。',
  '4. 语气与原文一致；原文是标题就译成标题，原文是列表项就译成列表项。',
  '5. 如果某项本身已经是目标语言，或没有任何可翻译内容，原样返回该项文本。',
].join('\n')

/**
 * 流式调用一次模型并聚合文本。
 * @param {any} llm - `ctx.llm`。
 * @param {Record<string, unknown>} options - GenerateOptions。
 * @returns {Promise<{ out: string, finish: any, usage: any }>} 聚合结果。
 */
async function streamOnce(llm, options) {
  let out = ''
  let finish = null
  let usage = null
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  return { out, finish, usage }
}

/**
 * 解析模型路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 生效配置。
 * @returns {{ provider: string, model: string, reasoningEffort?: string }} 路由。
 */
export function resolveRoute(ctx, config) {
  const provider = String(config.provider ?? '').trim()
  const model = String(config.model ?? '').trim()
  if (provider !== '' && model !== '') return { provider, model }
  if (provider !== '' || model !== '') {
    throw new Error('提供方与模型 ID 必须同时配置，或都留空以跟随 DSH 默认模型')
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection === undefined || selection === null || !selection.provider || !selection.model) {
    throw new Error('没有可用的模型路由：请在插件设置里指定 provider/model，或先在 DSH 设置默认模型')
  }
  const route = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) route.reasoningEffort = selection.reasoningEffort
  return route
}

/**
 * 翻译一批条目（一次模型调用）。
 *
 * 推理强度按 `inherit` 时不显式传，由模型默认决定；显式档位被拒绝时按路由
 * 默认档位重试一次（同一份自愈逻辑在 dsh-prompt-optimizer 里验证过）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {Array<{ id: string, text: string }>} items - 待翻译条目。
 * @param {string} targetLabel - 目标语言展示名。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ map: Map<string, string>, usage: any }>} id → 译文。
 */
async function translateViaDshModel(ctx, config, items, targetLabel, signal) {
  // 软读：免费路径是本插件的默认与主线，所以 llm 不在 inject 里，
  // 直接写 ctx.llm 会抛 "cannot get property llm without inject" 并回滚整个 fiber。
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) throw new Error('宿主没有可用的 llm 服务（本插件默认走自带免费服务，无需模型）')
  const route = resolveRoute(ctx, config)
  const user = `目标语言：${targetLabel}\n\n${JSON.stringify(items.map((item) => ({ id: item.id, text: item.text })))}`
  const options = {
    provider: route.provider,
    model: route.model,
    system: TRANSLATE_SYSTEM,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin:dsh-immersive-translate' },
    }],
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    signal,
  }
  let overrode = false
  if (config.reasoningEffort !== 'inherit') {
    options.reasoningEffort = config.reasoningEffort
    overrode = true
  }
  const withoutOverride = () => {
    const fallback = { ...options }
    if (route.reasoningEffort === undefined) delete fallback.reasoningEffort
    else fallback.reasoningEffort = route.reasoningEffort
    return fallback
  }
  let retried = false
  const retryable = (failure) => overrode && !retried && !signal?.aborted && isUnsupportedEffortFailure(failure)

  let result
  try {
    result = await streamOnce(llm, options)
  } catch (error) {
    if (!retryable(error)) throw error
    retried = true
    ctx.logger?.warn?.(`[immersive-translate] 模型不支持推理强度「${config.reasoningEffort}」，按默认档位重试`)
    result = await streamOnce(llm, withoutOverride())
  }
  if (result.finish?.kind === 'error') {
    if (retryable(result.finish.failure)) {
      retried = true
      ctx.logger?.warn?.(`[immersive-translate] 模型不支持推理强度「${config.reasoningEffort}」，按默认档位重试`)
      result = await streamOnce(llm, withoutOverride())
    }
  }
  const kind = result.finish?.kind
  if (kind === 'error') throw new Error(`模型调用失败：${result.finish.failure?.message ?? 'unknown'}`)
  if (kind === 'aborted') throw Object.assign(new Error(signal?.aborted ? '已取消' : '调用被中止'), { code: 'canceled' })
  if (kind === 'max-tokens') throw new Error(`输出达到 token 上限（${config.maxTokens}），可调大「单次输出 token 上限」或减小批量`)
  const map = parseTranslations(result.out, items)
  if (map.size === 0) throw new Error('模型没有返回可解析的译文（期望 JSON 数组）')
  return { map, usage: result.usage }
}

// ── 沉浸式翻译账号 ──────────────────────────────────────────────────────
//
// 对应原插件的账号体系：扩展把登录令牌存在 `chrome.storage.local` 的
// `user_token`（background.js 里的 `Ur` 键），随后用 `token` 请求头调
// `api2.immersivetranslate.cn`（`BASE_API + "v1/user"`）取用户信息。
// 桌面插件没有浏览器扩展的权限，无法自动截获登录页回传的令牌，因此这里提供
// "粘贴令牌 → 校验 → 持久化"的登录方式，语义与原插件一致。

/** 账号相关端点（取自扩展 background.js 的 BASE_API 与 Pro 服务配置）。 */
export const ACCOUNT_ENDPOINTS = {
  // background.js: BASE_API + "v1/user"，用于校验令牌并取用户信息。
  user: 'https://api2.immersivetranslate.cn/v1/user',
  // default_config.json: translationServices["zhipu-air-pro"].immersiveProApiUrl
  proTranslate: 'https://api2.immersivetranslate.cn/bigmodel-air/translate',
  // background.js: USER_LOGIN_URL
  login: 'https://immersivetranslate.com/accounts/login?from=plugin',
}

/**
 * 校验沉浸式翻译账号令牌并取回用户信息。
 *
 * 校验这一步必须做：否则用户填错一个字符，插件会在每次翻译时才报错，
 * 表现为"翻译突然全部失败"而不知原因。
 * @param {string} token - 从账号后台复制的令牌。
 * @param {object} [options] - { fetchImpl, signal }。
 * @returns {Promise<{ ok: true, user: object } | { ok: false, error: string }>} 校验结果。
 */
export async function verifyAccountToken(token, options = {}) {
  const value = String(token ?? '').trim()
  if (value === '') return { ok: false, error: '令牌为空' }
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(ACCOUNT_ENDPOINTS.user, {
      method: 'GET',
      headers: { 'content-type': 'application/json', token: value },
      signal: options.signal,
    })
    const payload = await response.json().catch(() => null)
    if (response.status === 401 || payload?.code === -1) {
      return { ok: false, error: '令牌无效或已过期，请重新登录获取' }
    }
    if (!response.ok || payload?.code !== 0 || payload?.data === undefined) {
      return { ok: false, error: payload?.message ?? payload?.error ?? `HTTP ${String(response.status)}` }
    }
    return { ok: true, user: payload.data }
  } catch (error) {
    return { ok: false, error: `无法连接账号服务：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 账号信息里适合回传给界面的字段（**剔除令牌本身**）。
 * @param {object} user - `v1/user` 返回的 data。
 * @returns {object | null} 可安全展示的账号摘要。
 */
export function publicAccount(user) {
  if (user === null || typeof user !== 'object') return null
  const pick = {}
  for (const key of ['nickname', 'name', 'email', 'avatar', 'avatarUrl', 'level', 'membership', 'isPro', 'expireTime', 'plan']) {
    if (user[key] !== undefined) pick[key] = user[key]
  }
  return pick
}

/**
 * 走沉浸式翻译账号（Pro）的翻译接口。
 *
 * 端点与请求形态取自扩展：`zhipu-air-pro.immersiveProApiUrl`
 * （`api2.immersivetranslate.cn/bigmodel-air/translate`），鉴权用 `token` 请求头。
 * 需要登录；未登录时直接给出可行动提示，而不是让它变成一次神秘的 401。
 * @param {object} options - { items, targetLanguage, token, signal, fetchImpl }。
 * @returns {Promise<Map<string, string>>} id → 译文。
 */
async function translateViaAccount({ items, targetLanguage, token, signal, fetchImpl }) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('未登录沉浸式翻译账号（在「设置 → 沉浸式翻译」里登录后可用 Pro 翻译）')
  }
  const doFetch = fetchImpl ?? fetch
  const response = await doFetch(ACCOUNT_ENDPOINTS.proTranslate, {
    method: 'POST',
    headers: { 'content-type': 'application/json', token },
    body: JSON.stringify({
      source: { lang: 'auto' },
      target: { lang: targetLanguage },
      text_list: items.map((item) => item.text),
    }),
    signal,
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401 || payload?.code === -1) {
    throw new Error('账号令牌无效或已过期，请重新登录')
  }
  if (!response.ok) throw new Error(`账号翻译 HTTP ${String(response.status)}：${payload?.message ?? payload?.error ?? ''}`)
  // 兼容两种返回形态：数组字段名可能随服务变化，尽量都认。
  const list = payload?.translations ?? payload?.data?.translations ?? payload?.auto_translation ?? payload?.data
  if (!Array.isArray(list)) throw new Error(`账号翻译返回了无法识别的结构：${JSON.stringify(payload).slice(0, 120)}`)
  const map = new Map()
  items.forEach((item, index) => {
    const value = typeof list[index] === 'string' ? list[index] : list[index]?.text ?? list[index]?.translation
    if (typeof value === 'string' && value !== '') map.set(item.id, value)
  })
  return map
}

/** 免费服务的回退顺序：transmart 已实测可用，其余作为候选。 */
const FREE_FALLBACK_ORDER = ['transmart', 'zhipu-free', 'google']

/** 引擎选择：`auto`=免费优先（默认）、`account`=账号 Pro、`dsh-model`=借宿主模型。 */
export const ENGINES = ['auto', 'account', 'transmart', 'zhipu-free', 'google', 'dsh-model']

/**
 * 用沉浸式翻译自带的免费服务翻译一批。
 *
 * 这是默认路径：**不经过 DSH 的模型路由**，因此不会消耗用户自己在用的模型额度，
 * 对应原插件"自带免费翻译"的行为。
 *
 * 按 `FREE_FALLBACK_ORDER` 依次尝试；某个服务报错（网络不可达、被 Cloudflare 拦、
 * 语言不支持）就换下一个。全部失败才抛错，由上层决定是否回退到模型。
 * @param {object} ctx - 宿主上下文（取 logger 与账号令牌）。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {Array<{ id: string, text: string }>} items - 本批条目。
 * @param {string} targetLabel - 目标语言展示名。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ map: Map<string, string>, usage: null, service: string }>} 译文与所用服务。
 */
async function translateViaFreeService(ctx, config, items, targetLabel, signal) {
  const token = typeof config.accountToken === 'string' ? config.accountToken : ''
  const order = typeof config.freeService === 'string' && config.freeService !== '' && config.freeService !== 'auto'
    ? [config.freeService, ...FREE_FALLBACK_ORDER.filter((id) => id !== config.freeService)]
    : FREE_FALLBACK_ORDER
  const failures = []
  for (const serviceId of order) {
    const service = FREE_SERVICES[serviceId]
    // 未实现的服务直接跳过，不让它出现在回退链里白白失败一次。
    if (service === undefined || service.implemented === false) continue
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
    try {
      const map = await callFreeServiceWithRetry({
        serviceId,
        items,
        targetLanguage: config.targetLanguage,
        signal,
        token,
      })
      if (map.size === 0) throw new Error('未返回任何译文')
      if (failures.length > 0) {
        ctx.logger?.info?.(`[immersive-translate] 免费服务 ${serviceId} 成功（前序失败：${failures.join('; ')}）`)
      }
      return { map, usage: null, service: serviceId }
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'canceled' })
      const reason = `${serviceId}: ${error instanceof Error ? error.message : String(error)}`
      failures.push(reason)
      ctx.logger?.warn?.(`[immersive-translate] 免费服务失败，尝试下一个 — ${reason}`)
    }
  }
  throw new Error(`全部免费服务都失败了：${failures.join(' | ')}`)
}

/**
 * 翻译一批：默认走自带免费服务；只有显式配置 `useDshModel` 时才借 DSH 的模型。
 * @param {object} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {Array<{ id: string, text: string }>} items - 本批条目。
 * @param {string} targetLabel - 目标语言展示名。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ map: Map<string, string>, usage: any, service: string }>} 结果。
 */
async function translateBatch(ctx, config, items, targetLabel, signal) {
  const engine = typeof config.engine === 'string' && config.engine !== '' ? config.engine : 'auto'
  // 显式借宿主模型：只有用户明确选它才走这里。
  if (engine === 'dsh-model' || config.useDshModel === true) {
    return { ...(await translateViaDshModel(ctx, config, items, targetLabel, signal)), service: 'dsh-model' }
  }
  // 账号 Pro：用户已登录并选了它，就不再往下回退（否则静默换成免费服务会让人困惑）。
  if (engine === 'account') {
    const map = await callFreeService({
      serviceId: 'account',
      items,
      targetLanguage: config.targetLanguage,
      signal,
      token: typeof config.accountToken === 'string' ? config.accountToken : '',
    })
    if (map.size === 0) throw new Error('账号翻译未返回任何译文')
    return { map, usage: null, service: 'account' }
  }
  // 用户点名了某个具体服务：锁定它，不再按回退链换别家
  // （否则"我选了 google"会被 transmart 先接走，选择形同虚设）。
  if (engine !== 'auto' && engine !== '' && FREE_SERVICES[engine] !== undefined) {
    const map = await callFreeService({
      serviceId: engine,
      items,
      targetLanguage: config.targetLanguage,
      signal,
      token: typeof config.accountToken === 'string' ? config.accountToken : '',
    })
    if (map.size === 0) throw new Error(`${engine} 未返回任何译文`)
    return { map, usage: null, service: engine }
  }
  try {
    return await translateViaFreeService(ctx, config, items, targetLabel, signal)
  } catch (error) {
    // 免费服务全挂时，只有用户允许才回退到 DSH 模型；默认不回退，避免悄悄花掉额度。
    if (config.allowModelFallback !== true) throw error
    ctx.logger?.warn?.(`[immersive-translate] 免费服务全部失败，回退到 DSH 模型：${error instanceof Error ? error.message : String(error)}`)
    return { ...(await translateViaDshModel(ctx, config, items, targetLabel, signal)), service: 'dsh-model' }
  }
}

/**
 * 按字符与条数预算把块切成批次。
 * @param {Array<{ id: string, text: string }>} items - 待翻译条目。
 * @param {number} charBudget - 单批字符上限。
 * @param {number} itemBudget - 单批条数上限。
 * @returns {Array<Array<{ id: string, text: string }>>} 批次。
 */
export function planBatches(items, charBudget, itemBudget) {
  const batches = []
  let current = []
  let chars = 0
  for (const item of items) {
    const size = item.text.length + 24 // 加上 JSON 结构开销
    if (current.length > 0 && (current.length >= itemBudget || chars + size > charBudget)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 有并发上限地映射。
 * @template T, R
 * @param {T[]} items - 输入。
 * @param {number} limit - 并发上限。
 * @param {(item: T, index: number) => Promise<R>} worker - 处理函数。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<R[]>} 与输入同序的结果。
 */
async function mapLimit(items, limit, worker, signal) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      if (signal?.aborted) return
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/** 读取请求体（带上限）。 */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'body-too-large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(Object.assign(new Error(`invalid JSON: ${error.message}`), { code: 'bad-body' }))
      }
    })
    req.on('error', reject)
  })
}

/** 写 JSON 响应（客户端已断开时静默跳过）。 */
function writeJson(res, status, body, extraHeaders) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    })
    res.end(JSON.stringify(body))
  } catch {
    /* 响应已不可写 */
  }
}

/**
 * 请求来源闸：只接受本机、同源请求。
 *
 * 直挂 webServer 的路由不经过官方 `/api` 桥的鉴权，必须自带这道闸，否则
 * 局域网内任何页面都能借本机的模型路由白嫖翻译。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {boolean} 是否放行。
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const headers = request?.headers
  const host = headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 把底层网络/HTTP 异常翻译成用户能据此行动的说明。
 *
 * undici 抛出的 `fetch failed` 只带一个嵌套 cause，直接把 message 透出去用户
 * 完全无法判断是"站点挂了"还是"本机网络出不去"（2026-09-24 实测：抓
 * en.wikipedia.org 时报 "抓取失败：fetch failed"，看不出是网络层被阻断）。
 * @param {unknown} error - 原始异常。
 * @param {string} url - 目标地址。
 * @returns {string} 可操作的错误说明。
 */
export function describeFetchError(error, url) {
  const parts = []
  let cursor = error
  const seen = new Set()
  while (cursor !== null && cursor !== undefined && !seen.has(cursor) && parts.length < 4) {
    seen.add(cursor)
    const code = typeof cursor.code === 'string' ? cursor.code : undefined
    const message = typeof cursor.message === 'string' ? cursor.message : undefined
    const label = code !== undefined && message !== undefined && !message.includes(code) ? `${message} (${code})` : (message ?? code)
    if (typeof label === 'string' && label.trim() !== '') parts.push(label.trim())
    cursor = cursor.cause
  }
  const detail = parts.join(' ← ') || 'unknown error'
  const hint = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)
    ? '域名解析失败：本机当前网络或代理到不了这个站点。'
    : /ECONN|ETIMEDOUT|fetch failed|socket hang up|UND_ERR/i.test(detail)
      ? '连接失败：站点不可达，或本机代理/防火墙拦下了这次请求。'
      : /403|401/i.test(detail)
        ? '站点拒绝了这次抓取（可能要求登录或有反爬策略）。'
        : ''
  return `${detail}${hint === '' ? '' : `\n${hint}`}\n目标：${url}`
}

/**
 * 整页翻译的总时长上限（毫秒）——**起步值**。
 *
 * 这是"整页所有批次加起来"的预算，不是单次请求的预算：单批的硬约束是
 * `translateBatch` 自己的 `timeoutMs`，这里只兜住"页面大到没完没了"。
 *
 * 起步时还不知道页面有多少段，按最坏情况估（`maxBlocks` 段各占一批）。
 * `translatePage` 一开始就发带**真实批次数**的 `meta` 事件，流式路由收到后用
 * {@link streamingBudgetForBatches} 收紧——小页面不必白等，大页面也不会被过早掐断。
 * 原实现写死 `max(timeoutMs*4, 300_000)`，与页面大小无关（2026-09-24 实测）。
 * @param {{ maxBlocks?: number }} config - 生效配置。
 * @returns {number} 起步毫秒数。
 */
export function streamingBudgetMs(config) {
  const maxBlocks = typeof config.maxBlocks === 'number' && config.maxBlocks > 0 ? config.maxBlocks : 500
  return streamingBudgetForBatches(config, maxBlocks)
}

/**
 * 按已知批次数算总时长预算。
 *
 * 用**典型**单批延迟（而不是最坏 `timeoutMs`）估算：把它当典型值会算出天文数字，
 * 让预算失去意义。单批的硬上界仍由 `timeoutMs` 在 `translateBatch` 内部保证，所以
 * 这里只需给出"正常情况下的合理等待上限"，并按并发摊薄。夹在 [60 秒, 10 分钟]。
 * @param {{ concurrency?: number }} config - 生效配置。
 * @param {number} batchCount - 真实批次数（来自 meta 事件）。
 * @returns {number} 该次整页翻译允许的总毫秒数。
 */
export function streamingBudgetForBatches(config, batchCount) {
  /** 单批典型延迟（毫秒）：一段至数段短文本的翻译调用。 */
  const TYPICAL_BATCH_MS = 15_000
  const concurrency = typeof config?.concurrency === 'number' && config.concurrency > 0 ? config.concurrency : 1
  const batches = typeof batchCount === 'number' && batchCount > 0 ? batchCount : 1
  return Math.min(600_000, Math.max(60_000, Math.ceil((TYPICAL_BATCH_MS * batches) / concurrency)))
}

/** 目标语言的展示名。 */
function targetLabelOf(config) {
  return TARGET_LANGUAGES.find((item) => item.id === config.targetLanguage)?.label ?? config.targetLanguage
}

/**
 * 翻译一段纯文本（划词/短句路径）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {string} text - 待翻译文本。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<{ text: string, usage: any }>} 译文。
 */
async function translateText(ctx, config, text, signal) {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('文本为空')
  if (trimmed.length > MAX_TEXT_CHARS) throw new Error(`文本过长（${trimmed.length} > ${MAX_TEXT_CHARS} 字符）`)
  const { map, usage } = await translateBatch(ctx, config, [{ id: '1', text: trimmed }], targetLabelOf(config), signal)
  const translated = map.get('1')
  if (translated === undefined) throw new Error('模型没有返回译文')
  return { text: translated, usage }
}

/**
 * 抓取 + 抽取 + 翻译一页，逐块回调。
 *
 * 抽块与翻译分离是为了让面板能先把原文铺出来（用户可立即阅读），译文随到随填。
 * @param {object} deps - 依赖包。
 * @param {string} url - 目标 URL。
 * @param {AbortSignal} signal - 取消信号。
 * @param {(event: Record<string, unknown>) => void} emit - 事件回调。
 * @returns {Promise<{ blocks: number, translated: number, failed: number }>} 统计。
 */
async function translatePage(deps, url, signal, emit) {
  const { ctx, config } = deps
  const fetched = await fetchHtml(deps, url, signal)
  const blocks = extractBlocks(fetched.html, { maxBlocks: config.maxBlocks })
  const rule = resolveRule(fetched.url, config.userRules)
  const title = extractTitle(fetched.html)
  if (blocks.length === 0) {
    emit({ type: 'meta', url: fetched.url, title, status: fetched.status, via: fetched.via, total: 0, batches: 0, translatable: 0, rule: rule.matched ? rule : null })
    emit({ type: 'done', translated: 0, failed: 0, reason: 'no-blocks' })
    return { blocks: 0, translated: 0, failed: 0 }
  }
  // 不可翻译的块（代码、纯数字、隐藏元素）直接以原文回填，保留阅读节奏。
  const translatable = []
  blocks.forEach((block, index) => {
    const record = { index, kind: block.kind, source: block.text, translation: '', translatable: block.translatable }
    if (!block.translatable) emit({ type: 'block', ...record, skipped: true })
    else translatable.push({ id: String(index), text: block.text, index })
  })
  const batches = planBatches(translatable.map((item) => ({ id: item.id, text: item.text })), config.batchChars, BATCH_ITEMS)
  // 批次数在 meta 里报出去：这是"这次翻译要打几次模型"的真实答案，客户端据此
  // 显示进度预期，流式路由也用它把总时长预算收紧到实际需要的量级。
  emit({ type: 'meta', url: fetched.url, title, status: fetched.status, via: fetched.via, total: blocks.length, batches: batches.length, translatable: translatable.length, rule: rule.matched ? rule : null })
  let translated = 0
  let failed = 0
  const label = targetLabelOf(config)
  await mapLimit(batches, config.concurrency, async (batch) => {
    if (signal.aborted) return
    try {
      const { map } = await translateBatch(ctx, config, batch, label, signal)
      for (const item of batch) {
        const value = map.get(item.id)
        if (value === undefined) {
          failed += 1
          emit({ type: 'block-error', index: Number(item.id), message: '该段没有返回译文' })
          continue
        }
        translated += 1
        const block = blocks[Number(item.id)]
        emit({ type: 'block', index: Number(item.id), kind: block.kind, source: block.text, translation: value, translatable: true })
      }
    } catch (error) {
      if (signal.aborted) return
      failed += batch.length
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'batch-error', indexes: batch.map((item) => Number(item.id)), message })
    }
  }, signal)
  emit({ type: 'done', translated, failed })
  return { blocks: blocks.length, translated, failed }
}

/**
 * 组装插件的两个模型工具。
 * @param {object} deps - 依赖包。
 * @returns {Array<Record<string, unknown>>} 工具定义。
 */
function buildTools(deps) {
  const { ctx, configOf } = deps
  return [
    {
      name: 'translate_text',
      description: [
        '把一段文本翻译成目标语言（默认简体中文）。用于阅读外文内容、翻译引用、理解用户贴来的外文片段。',
        '默认走沉浸式翻译自带的免费翻译服务，不需要 API key，也不消耗你在 DSH 里配置的模型额度；目标语言与引擎可在插件设置里改。',
        '只翻译单段文本；要整页双语对照请用 translate_page。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待翻译文本（上限 8000 字符）。' },
          targetLanguage: { type: 'string', description: `目标语言代码，默认取插件设置（可选：${TARGET_LANGUAGES.map((item) => item.id).join(', ')}）。` },
        },
        required: ['text'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const config = configOf()
        const language = typeof args.targetLanguage === 'string' && args.targetLanguage.trim() !== '' ? args.targetLanguage.trim() : config.targetLanguage
        const label = TARGET_LANGUAGES.find((item) => item.id === language)?.label ?? language
        const effective = { ...config, targetLanguage: language }
        const result = await translateText(ctx, effective, String(args.text ?? ''), exec?.signal)
        return `目标语言：${label}\n\n${result.text}`
      },
    },
    {
      name: 'translate_page',
      description: [
        '抓取一个网页并按段落做双语翻译，返回「原文 + 译文」对照文本。用于读外文文档、文章、issue、release notes。',
        '默认走沉浸式翻译自带的免费翻译服务，不消耗 DSH 里配置的模型额度。抓取优先使用部署里配置的 web 抓取 provider，失败回落到原生 fetch。',
        '输出是纯文本对照（不是 HTML）；页面很长时按 maxBlocks 截断，返回里会说明。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要翻译的页面 URL（http/https）。' },
          targetLanguage: { type: 'string', description: `目标语言代码，默认取插件设置（可选：${TARGET_LANGUAGES.map((item) => item.id).join(', ')}）。` },
          maxBlocks: { type: 'number', description: '最多翻译多少段（默认取插件设置，上限 2000）。' },
        },
        required: ['url'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const url = String(args.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http/https 绝对地址')
        const base = configOf()
        const language = typeof args.targetLanguage === 'string' && args.targetLanguage.trim() !== '' ? args.targetLanguage.trim() : base.targetLanguage
        const label = TARGET_LANGUAGES.find((item) => item.id === language)?.label ?? language
        const maxBlocks = clampNumber(args.maxBlocks, base.maxBlocks, 20, 2000)
        const config = { ...base, targetLanguage: language, maxBlocks }
        const lines = []
        lines.push(`# ${url}`)
        lines.push('')
        lines.push(`> 目标语言：${label}`)
        const outcome = await translatePage(
          { ctx, config },
          url,
          exec.signal,
          (event) => {
            if (event.type === 'meta') {
              if (event.title) lines.push(`> 页面标题：${event.title}`)
              lines.push(`> 共 ${event.total} 段，抓取方式：${event.via}`)
              lines.push('')
            } else if (event.type === 'block') {
              lines.push(event.source)
              lines.push(event.translation === '' ? '（本段未翻译）' : event.translation)
              lines.push('')
            } else if (event.type === 'batch-error') {
              lines.push(`（第 ${event.indexes.length} 段翻译失败：${event.message}）`)
              lines.push('')
            }
          },
        )
        lines.push(`---\n统计：${outcome.blocks} 段，译文 ${outcome.translated} 段，失败 ${outcome.failed} 段。`)
        return lines.join('\n')
      },
    },
  ]
}

/**
 * 挂载宿主半。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} declared - profile 条目声明的 config。
 */
export function apply(ctx, declared) {
  const declaredConfig = declared !== null && typeof declared === 'object' ? declared : {}
  const stored = readSettingsFile()
  let current = normalizeConfig(declaredConfig, stored)
  /** 配置读取口：工具与路由每次调用都取最新值，改设置免重挂载。 */
  const configOf = () => current

  ctx.logger?.info?.(`[immersive-translate] 已挂载（协议 v${String(HOST_PROTOCOL)}，目标语言 ${current.targetLanguage}，引擎 ${current.engine}${current.engine === 'dsh-model' ? `，模型 ${current.provider || '跟随默认'}/${current.model || '-'}` : ''}）`)

  // ── 设置读写 ────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/settings',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method === 'GET') {
        return writeJson(res, 200, {
          ok: true,
          hostProtocol: HOST_PROTOCOL,
          config: current,
          defaults: DEFAULTS,
          languages: TARGET_LANGUAGES,
          storedPath: settingsPath(),
          storedKeys: Object.keys(readSettingsFile()),
        })
      }
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'GET or POST only' }, { allow: 'GET, POST' })
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return writeJson(res, 400, { ok: false, error: `bad body: ${error.message}` })
      }
      const patch = body?.config !== null && typeof body?.config === 'object' ? body.config : body
      try {
        // 必须**合并**而不是覆盖：账号令牌与设置同存一个文件，
        // 若这里直接覆盖，用户一保存设置就会把已登录的令牌清掉。
        // 同时只落显式传入的已知字段（不写默认值），否则以后改默认值不再生效。
        const merged = writeSettingsPatch(patch)
        const next = normalizeConfig(declaredConfig, merged)
        current = next
        ctx.logger?.info?.('[immersive-translate] 设置已更新')
        return writeJson(res, 200, { ok: true, hostProtocol: HOST_PROTOCOL, config: current })
      } catch (error) {
        return writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'immersive-translate: settings route')

  // ── 抓取 + 抽块 ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/fetch',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' })
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on?.('close', onClose)
      const timer = setTimeout(() => controller.abort(), current.timeoutMs)
      // url 必须在 try 之外声明：catch 里要用它拼可读的失败说明。
      let fetchUrl = ''
      try {
        const body = await readBody(req)
        const url = String(body.url ?? '').trim()
        fetchUrl = url
        if (!/^https?:\/\//i.test(url)) return writeJson(res, 400, { ok: false, error: 'url 必须是 http/https 绝对地址' })
        const fetched = await fetchHtml({ ctx, config: current }, url, controller.signal)
        const blocks = extractBlocks(fetched.html, { maxBlocks: current.maxBlocks })
        const rule = resolveRule(fetched.url, current.userRules)
        writeJson(res, 200, {
          ok: true,
          url: fetched.url,
          title: extractTitle(fetched.html),
          status: fetched.status,
          via: fetched.via,
          total: blocks.length,
          blocks,
          rule: rule.matched ? rule : null,
        })
      } catch (error) {
        const aborted = controller.signal.aborted
        const message = aborted
          ? `抓取超时（${String(current.timeoutMs)}ms）：站点响应太慢，可在设置里调大「抓取超时」。`
          : `抓取失败：${describeFetchError(error, fetchUrl)}`
        writeJson(res, aborted ? 504 : 502, { ok: false, error: message })
      } finally {
        clearTimeout(timer)
        res.off?.('close', onClose)
      }
    },
  }), 'immersive-translate: fetch route')

  // ── 流式翻译（NDJSON） ──────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/translate',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' })
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on?.('close', onClose)
      // 先用保守预算起步；meta 到达后（已经知道真实批次数）再收紧成精确值。
      let timer = setTimeout(() => controller.abort(), streamingBudgetMs(current))
      /** meta 阶段已知真实批次后重设总预算，避免"页面小却硬等 10 分钟"。 */
      const retightenBudget = (batchCount) => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), streamingBudgetForBatches(current, batchCount))
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        clearTimeout(timer)
        res.off?.('close', onClose)
        return writeJson(res, 400, { ok: false, error: `bad body: ${error.message}` })
      }
      const url = String(body.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) {
        clearTimeout(timer)
        res.off?.('close', onClose)
        return writeJson(res, 400, { ok: false, error: 'url 必须是 http/https 绝对地址' })
      }
      const config = body.targetLanguage !== undefined && typeof body.targetLanguage === 'string' && body.targetLanguage !== ''
        ? { ...current, targetLanguage: body.targetLanguage }
        : current
      // NDJSON：一行一个事件，客户端边收边渲染，不必等整页翻完。
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        connection: 'keep-alive',
      })
      const emit = (event) => {
        // meta 里带着服务端算好的真实批次数：据此把总时长预算收紧到实际需要。
        if (event?.type === 'meta' && typeof event.batches === 'number' && event.batches > 0) {
          retightenBudget(event.batches)
        }
        if (res.writableEnded || res.destroyed) return
        try {
          res.write(`${JSON.stringify(event)}\n`)
        } catch {
          /* 客户端已断开 */
        }
      }
      try {
        await translatePage({ ctx, config }, url, controller.signal, emit)
      } catch (error) {
        if (!controller.signal.aborted) {
          // 抓取类失败在这里也要给出可行动说明：这条路径上 fetchHtml 的异常
          // 就是最外层错误，直接 emit message 会只剩 "fetch failed"。
          emit({ type: 'error', message: describeFetchError(error, url) })
        }
      } finally {
        clearTimeout(timer)
        res.off?.('close', onClose)
        if (!res.writableEnded && !res.destroyed) res.end()
      }
    },
  }), 'immersive-translate: translate route')

  // ── 就地注入用的批量翻译 ────────────────────────────────────────────────
  /**
   * 客户端内容脚本把页面上扫到的文本节点批量送进来，按 id 拿回译文。
   *
   * 这是"就地注入"路径的关键端点（原版扩展的 content script 也走同样形态）：
   * 页面把一批文本切成批次，每个批次一次请求，拿到译文后直接替换 DOM。
   * 与 /text 的区别是：入参是数组、返回按 id 对齐、逐批独立失败。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/batch',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' })
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on?.('close', onClose)
      const timer = setTimeout(() => controller.abort(), current.timeoutMs)
      try {
        const body = await readBody(req, 2 * 1024 * 1024)
        const rawItems = Array.isArray(body.items) ? body.items : []
        if (rawItems.length === 0) return writeJson(res, 400, { ok: false, error: 'items 不能为空' })
        // 清洗输入：只保留有 id 与文本的条目，去掉空白/超长项。
        const items = []
        for (const item of rawItems) {
          if (item === null || typeof item !== 'object') continue
          const id = String(item.id ?? '')
          const text = String(item.text ?? '')
          if (id === '' || text.trim() === '') continue
          items.push({ id, text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text })
          if (items.length >= 200) break
        }
        if (items.length === 0) return writeJson(res, 400, { ok: false, error: 'items 里没有可翻译的文本' })
        const config = typeof body.targetLanguage === 'string' && body.targetLanguage !== '' ? { ...current, targetLanguage: body.targetLanguage } : current
        const label = TARGET_LANGUAGES.find((entry) => entry.id === config.targetLanguage)?.label ?? config.targetLanguage
        const batches = planBatches(items, config.batchChars, BATCH_ITEMS)
        const translations = {}
        let failed = 0
        await mapLimit(batches, config.concurrency, async (batch) => {
          if (controller.signal.aborted) return
          try {
            const { map } = await translateBatch(ctx, config, batch, label, controller.signal)
            for (const item of batch) {
              const value = map.get(item.id)
              // 模型漏译某项时回填原文，让客户端保持排版而不是留下空洞。
              translations[item.id] = value === undefined ? item.text : value
              if (value === undefined) failed += 1
            }
          } catch (error) {
            if (controller.signal.aborted) return
            failed += batch.length
            for (const item of batch) translations[item.id] = item.text
            ctx.logger?.warn?.(`[immersive-translate] 批次失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }, controller.signal)
        writeJson(res, 200, { ok: true, translations, failed, total: items.length, language: config.targetLanguage })
      } catch (error) {
        const aborted = controller.signal.aborted
        writeJson(res, aborted ? 504 : 400, { ok: false, error: aborted ? `翻译超时（${String(current.timeoutMs)}ms）` : (error instanceof Error ? error.message : String(error)) })
      } finally {
        clearTimeout(timer)
        res.off?.('close', onClose)
      }
    },
  }), 'immersive-translate: batch route')

  // ── 账号：登录 / 登出 / 状态 ────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/account',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      // GET 取当前账号状态；POST 用令牌登录（校验后持久化）；DELETE 登出。
      if (req.method === 'GET') {
        const token = current.accountToken
        if (typeof token !== 'string' || token === '') return writeJson(res, 200, { ok: true, loggedIn: false })
        const verified = await verifyAccountToken(token)
        return writeJson(res, 200, {
          ok: true,
          loggedIn: verified.ok,
          user: verified.ok ? publicAccount(verified.user) : null,
          error: verified.ok ? undefined : verified.error,
          // 令牌校验失败时提示用户重新登录，而不是静默地一直是"已登录"。
          needsRelogin: !verified.ok,
        })
      }
      if (req.method === 'POST') {
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: `请求体解析失败：${error instanceof Error ? error.message : String(error)}` })
        }
        const token = String(body.token ?? '').trim()
        const verified = await verifyAccountToken(token)
        if (!verified.ok) return writeJson(res, 400, { ok: false, error: verified.error })
        current = normalizeConfig(declaredConfig, writeSettingsPatch({ accountToken: token }))
        ctx.logger?.info?.('[immersive-translate] 账号已登录')
        return writeJson(res, 200, { ok: true, loggedIn: true, user: publicAccount(verified.user) })
      }
      if (req.method === 'DELETE') {
        current = normalizeConfig(declaredConfig, writeSettingsPatch({ accountToken: '' }))
        return writeJson(res, 200, { ok: true, loggedIn: false })
      }
      return writeJson(res, 405, { ok: false, error: 'GET / POST / DELETE only' }, { allow: 'GET, POST, DELETE' })
    },
  }), 'immersive-translate: account route')

  // ── 免费服务可用性自检 ──────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/services',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' })
      // 探测每个免费服务是否真的可用：用户点"翻译"却没反应时，
      // 这个接口能直接告诉他"是哪个服务不通"，而不是让他猜（原插件也有类似自检）。
      const results = []
      for (const [id, service] of Object.entries(FREE_SERVICES)) {
        if (service.implemented === false) continue
        const started = Date.now()
        try {
          const map = await callFreeService({
            serviceId: id,
            items: [{ id: 'probe', text: 'Hello world' }],
            targetLanguage: current.targetLanguage,
            token: current.accountToken,
          })
          results.push({ id, label: service.label, ok: map.size > 0, ms: Date.now() - started, sample: map.get('probe') ?? null })
        } catch (error) {
          results.push({ id, label: service.label, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
        }
      }
      writeJson(res, 200, { ok: true, services: results, active: current.freeService })
    },
  }), 'immersive-translate: services route')

  // ── 划词/短句翻译 ───────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-immersive-translate/text',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' })
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on?.('close', onClose)
      const timer = setTimeout(() => controller.abort(), current.timeoutMs)
      try {
        const body = await readBody(req)
        const text = String(body.text ?? '')
        const config = typeof body.targetLanguage === 'string' && body.targetLanguage !== '' ? { ...current, targetLanguage: body.targetLanguage } : current
        const result = await translateText(ctx, config, text, controller.signal)
        writeJson(res, 200, { ok: true, text: result.text, usage: result.usage })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = controller.signal.aborted
        writeJson(res, timedOut ? 504 : 400, { ok: false, error: timedOut ? `翻译超时（${current.timeoutMs}ms）` : message })
      } finally {
        clearTimeout(timer)
        res.off?.('close', onClose)
      }
    },
  }), 'immersive-translate: text route')

  // ── 模型工具 ────────────────────────────────────────────────────────────
  for (const tool of buildTools({ ctx, configOf })) {
    ctx.effect(() => ctx.tools.register(tool), `immersive-translate: tool ${tool.name}`)
  }

  /** 卸载：无需额外清理（路由与工具都由各自的 ctx.effect 回收）。 */
  ctx.effect(() => () => {
    ctx.logger?.info?.('[immersive-translate] 已卸载')
  }, 'immersive-translate: teardown')
}

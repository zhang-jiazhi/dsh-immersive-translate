/**
 * @local/dsh-immersive-translate — 正文抽取与用户规则匹配。
 *
 * 与浏览器扩展不同，插件拿到的是 HTML 字符串而不是活 DOM，所以这里自带一个
 * 小型 tokenizer：按"标签 + 文本"线性扫描，用标签栈跟踪块级元素边界，把段落
 * 抽出来。不引入 HTML 解析依赖（插件市场不保证有 DOM 实现），但也不做正则
 * 乱切——属性值里的 `>`、嵌套同名标签都由扫描器正确处理。
 *
 * 产出的是纯文本块：译文在 DSH 面板里以纯文本渲染，内联标记（strong/a/span…）
 * 一律压平，避免把页面样式带进面板。
 */

/** 块级标签到输出 kind 的映射（面板按 kind 决定排版）。 */
const BLOCK_TAGS = new Map([
  ['h1', 'h1'], ['h2', 'h2'], ['h3', 'h3'], ['h4', 'h4'], ['h5', 'h5'], ['h6', 'h6'],
  ['p', 'p'], ['li', 'li'], ['td', 'td'], ['th', 'th'], ['dt', 'dt'], ['dd', 'dd'],
  ['blockquote', 'blockquote'], ['figcaption', 'figcaption'], ['caption', 'caption'],
  ['summary', 'summary'], ['pre', 'pre'],
])

/**
 * 容器型块：只有**内部不含其它块级元素**时才作为段落产出。
 *
 * 必须处理 div/section/article 的原因：现代站点（SPA、Markdown 渲染器）大量
 * 直接把正文文本放在 div 里，不认它们就整页抽不到东西。而把它们无条件当块
 * 又会造成嵌套重复（外层 div 把内层所有段落再吞一遍）并产出一坨巨大的"整页
 * 一段"。所以判据是"叶子容器才算段落"。
 */
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'figure', 'details', 'fieldset'])

/**
 * 整体丢弃的子树：里面的内容不是正文。
 * 抽块时按深度跳过，不会因为脚本里出现 "<p>" 字面量而误判。
 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'template', 'iframe', 'object',
  'embed', 'head', 'nav', 'footer', 'form', 'button', 'select', 'textarea', 'audio', 'video',
])

/** 不翻译、但保留原文的标签（与扩展的 excludeTags 口径一致）。 */
const NO_TRANSLATE_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'math'])

/** 单块最大字符数：超长块切句，避免一次请求塞爆上下文。 */
const MAX_BLOCK_CHARS = 1200

/** 少于这个字数的块不值得翻译（页码、图标名之类）。 */
const MIN_BLOCK_CHARS = 2

/** 几乎没有可翻译内容：纯数字/符号、整条 URL、单个邮箱。 */
const SKIP_TEXT_RE = /^(?:[\s\d\p{P}\p{S}]*|\w+:\/\/\S+|\S+@\S+\.\S+)$/u

/**
 * 样板/无障碍文本：站点导航与跳转链接不是正文，翻出来只是噪音。
 *
 * MDN 的 "Skip to main content"、常见 "Toggle navigation"、"Back to top" 之类
 * 会占据面板最前面好几行（2026-09-24 实测 MDN 页面 49 段里前 5 段都是这类）。
 * 这里只挡**整段恰好等于**这些短语的块，不做子串包含，避免误伤正常句子。
 */
const BOILERPLATE_RE = /^(?:skip to (?:main )?content|skip (?:to|navigation)|jump to (?:main )?content|toggle navigation|toggle menu|open menu|close menu|back to top|scroll (?:up|to top)|search|menu|home|sign in|sign up|log in|login|logout|register|subscribe|share|print|download|table of contents|edit|view source|permalink|breadcrumb|cookie (?:settings|policy)|accept (?:all )?cookies|advertisement|sponsored|related (?:articles|posts)|previous|next|read more|learn more|more|submit|reset|continue|dismiss)$/i

/**
 * 纯导航噪声里的块级 kind：li/td 常用于菜单，标题里的站点名也常重复。
 * 只用于"整段恰好是样板短语"的判定，不影响其它内容。
 * @param {string} text - 纯文本。
 * @returns {boolean} 是否是样板文本。
 */
export function isBoilerplate(text) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return true
  return BOILERPLATE_RE.test(normalized)
}

/** 常见 HTML 实体。 */
const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['mdash', '—'], ['ndash', '–'], ['hellip', '…'], ['times', '×'], ['middot', '·'],
  ['ldquo', '“'], ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’'], ['copy', '©'], ['reg', '®'],
])

/** 自闭合/空元素：不进入标签栈。 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'area', 'base', 'col', 'wbr'])

/**
 * 解码 HTML 实体（含数字实体）。
 * @param {string} text - 原始文本。
 * @returns {string} 解码后的文本。
 */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const known = ENTITIES.get(body.toLowerCase())
    return known === undefined ? match : known
  })
}

/**
 * 把一段含标记的 HTML 压平成可读纯文本。
 * @param {string} html - 片段。
 * @returns {string} 压平后的文本。
 */
export function textOf(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[\t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * 抽取 `<title>`。
 * @param {string} html - document HTML。
 * @returns {string} 标题或空串。
 */
export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return match === null ? '' : textOf(match[1]).replace(/\s+/g, ' ').trim()
}

/**
 * 扫描 HTML 标签：返回 `{ name, closing, selfClosing, attrs, start, end }` 序列。
 *
 * 属性值里的 `>` 由引号状态机处理，不会被当成标签结束。
 * @param {string} html - 输入 HTML。
 * @returns {Array<{ name: string, closing: boolean, selfClosing: boolean, attrs: string, start: number, end: number }>} 标签列表。
 */
export function scanTags(html) {
  const tags = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    // 注释：整体跳过。
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close < 0 ? html.length : close + 3
      continue
    }
    const header = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64))
    if (header === null) {
      i = lt + 1
      continue
    }
    const name = header[1].toLowerCase()
    const closing = html[lt + 1] === '/'
    // 引号状态机找标签结束的 '>'。
    let j = lt + header[0].length
    let quote = null
    while (j < html.length) {
      const char = html[j]
      if (quote !== null) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
      j += 1
    }
    if (j >= html.length) break
    const attrs = html.slice(lt + header[0].length, j)
    tags.push({ name, closing, selfClosing: /\/\s*$/.test(attrs) || VOID_TAGS.has(name), attrs, start: lt, end: j + 1 })
    i = j + 1
  }
  return tags
}

/**
 * 把超长文本切成不超过 MAX_BLOCK_CHARS 的多段。
 * @param {string} text - 一个块的全部文本。
 * @returns {string[]} 分段结果（至少一段）。
 */
export function splitLong(text) {
  if (text.length <= MAX_BLOCK_CHARS) return [text]
  const out = []
  let current = ''
  for (const sentence of text.split(/(?<=[.!?。！？；;])\s*/u)) {
    if (sentence.length > MAX_BLOCK_CHARS) {
      if (current.trim() !== '') {
        out.push(current.trim())
        current = ''
      }
      for (let i = 0; i < sentence.length; i += MAX_BLOCK_CHARS) out.push(sentence.slice(i, i + MAX_BLOCK_CHARS))
      continue
    }
    if (current !== '' && (current + sentence).length > MAX_BLOCK_CHARS) {
      out.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim() !== '') out.push(current.trim())
  return out.length === 0 ? [text] : out
}

/**
 * 这个块值得翻译吗。
 * @param {string} text - 纯文本。
 * @returns {boolean} 是否需要翻译。
 */
export function worthTranslating(text) {
  if (text.length < MIN_BLOCK_CHARS) return false
  if (SKIP_TEXT_RE.test(text)) return false
  // 至少两个字母/汉字，避免把 "A"、"12" 这类孤字送去翻译。
  const letters = text.match(/[\p{L}\p{Script=Han}]/gu)
  return letters !== null && letters.length >= 2
}

/**
 * 把 HTML 切成可翻译的块。
 *
 * 线性扫描标签流，用标签栈跟踪"当前处在哪个块级元素内"：
 *  - BLOCK_TAGS（p/h1/li/…）进入即开块，退出即收尾；
 *  - CONTAINER_TAGS（div/section/…）只在**内部没有其它块级元素**时才算一个
 *    段落（叶子容器），否则只取出它夹在子块之间的直接文本，避免嵌套重复；
 *  - DROP_TAGS 子树按深度整段跳过；
 *  - NO_TRANSLATE_TAGS（pre/code）内保留原文但标记不可翻译。
 *
 * 每个 frame 只承接"自己是栈顶时"出现的文本，所以 `<li><p>x</p></li>` 只在
 * `p` 上产出一次 `x`，`li` 自己的直接文本为空、不产出。
 *
 * @param {string} html - document HTML。
 * @param {{ maxBlocks?: number, kindFilter?: (kind: string) => boolean }} [options] - 抽取选项。
 * @returns {Array<{ kind: string, text: string, translatable: boolean }>} 块序列。
 */
export function extractBlocks(html, options = {}) {
  const maxBlocks = typeof options.maxBlocks === 'number' ? options.maxBlocks : 500
  const tags = scanTags(html)
  const blocks = []
  /** 打开的块级元素栈：`{ kind, raw, noTranslate, hidden, childBlocks }`。 */
  const open = []
  /** DROP_TAGS 的深度计数：> 0 时整段跳过。 */
  let dropDepth = 0

  /** 把文本挂到最内层 frame（外层靠自己的直接文本来产出，不重复收集）。 */
  const pushText = (raw) => {
    if (dropDepth > 0 || raw === '') return
    const frame = open[open.length - 1]
    if (frame === undefined) return
    frame.raw.push(decodeEntities(raw))
  }

  /** 把一段纯文本按 kind 收成块（超长切分）。 */
  const emitText = (kind, raw, frame) => {
    const text = textOf(raw).replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
    if (text === '') return
    for (const piece of splitLong(text)) {
      // 样板文本在这里就丢掉（而不是最后再 filter）：maxBlocks 是"保留多少段"的
      // 额度，若让菜单/跳转链接先进 blocks，噪音多的页面会把额度吃光、正文一段
      // 都剩不下（2026-09-24 实测：30 条 "Skip to main content" + 8 段正文、额度 5
      // → 输出 0 段）。
      if (isBoilerplate(piece)) continue
      blocks.push({
        kind,
        text: piece,
        // 隐藏元素（display:none / hidden / aria-hidden）保留占位但标记不可译。
        translatable: worthTranslating(piece) && !frame.noTranslate && !frame.hidden,
      })
    }
  }

  /** 收尾最内层 frame。 */
  const closeFrame = () => {
    const frame = open.pop()
    if (frame === undefined) return
    const isContainer = CONTAINER_TAGS.has(frame.tag)
    // 叶子容器按段落产出；非叶子容器只产出夹在子块之间的直接文本。
    if (!isContainer || frame.childBlocks === 0) emitText(frame.outputKind, frame.raw.join(''), frame)
    else emitText('p', frame.raw.join(''), frame)
  }

  let cursor = 0
  for (const tag of tags) {
    if (blocks.length >= maxBlocks) break
    if (tag.start > cursor) pushText(html.slice(cursor, tag.start))
    cursor = tag.end

    if (DROP_TAGS.has(tag.name)) {
      if (tag.closing) dropDepth = Math.max(0, dropDepth - 1)
      else if (!tag.selfClosing) dropDepth += 1
      continue
    }
    if (dropDepth > 0) continue

    const blockKind = BLOCK_TAGS.get(tag.name)
    const isContainer = CONTAINER_TAGS.has(tag.name)
    if (blockKind === undefined && !isContainer) continue

    if (tag.closing) {
      // 只闭合与栈顶同名的 frame；错配的闭合标签忽略（容错烂 HTML）。
      const top = open[open.length - 1]
      if (top !== undefined && top.tag === tag.name) closeFrame()
      continue
    }
    if (tag.selfClosing) continue

    const parent = open[open.length - 1]
    if (parent !== undefined) parent.childBlocks += 1
    const hidden = /(?:display\s*:\s*none|(?:^|\s)hidden(?:\s|=|$)|aria-hidden\s*=\s*["']?true)/i.test(tag.attrs)
    open.push({
      tag: tag.name,
      outputKind: blockKind ?? 'p',
      raw: [],
      // `<pre><code>` 嵌套：只要任一层不翻译，整块就不翻译。
      noTranslate: NO_TRANSLATE_TAGS.has(tag.name) || open.some((frame) => frame.noTranslate),
      hidden: hidden || open.some((frame) => frame.hidden),
      childBlocks: 0,
    })
  }
  if (cursor < html.length && blocks.length < maxBlocks) pushText(html.slice(cursor))
  while (open.length > 0) closeFrame()

  const filtered = typeof options.kindFilter === 'function' ? blocks.filter((block) => options.kindFilter(block.kind)) : blocks
  return filtered.slice(0, maxBlocks)
}

/**
 * 通配符模式 → 正则。
 * @param {string} pattern - 含 `*` 的模式。
 * @returns {RegExp} 全串匹配正则。
 */
function wildcardRe(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '\u0000' : `\\${char}`))
  return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`, 'i')
}

/**
 * 判断一条规则是否命中 URL。
 *
 * 与扩展同口径：`matches` 可为字符串或数组，`*` 是通配符；省略协议时按
 * "域名全等 / 域名后缀 / 子串"三级匹配（扩展里 `*.twitter.com`、`www.google.com`
 * 都能命中对应站点）。
 * @param {string} url - 页面 URL。
 * @param {string | string[]} matches - 规则里的 matches 字段。
 * @returns {boolean} 是否命中。
 */
export function matchUrl(url, matches) {
  const patterns = Array.isArray(matches) ? matches : [matches]
  let host = ''
  let href = url
  try {
    const parsed = new URL(url)
    host = parsed.hostname.toLowerCase()
    href = parsed.href
  } catch {
    /* 非绝对 URL：退化为子串匹配 */
  }
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const pattern = raw.trim()
    if (pattern === '*' || pattern === '<all_urls>') return true
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) {
      if (wildcardRe(pattern).test(href)) return true
      continue
    }
    const bare = pattern.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/^\./, '').toLowerCase()
    if (bare === '') continue
    if (host === bare || host.endsWith(`.${bare}`)) return true
    if (bare.includes('*')) {
      if (wildcardRe(bare).test(host)) return true
      continue
    }
    if (host.includes(bare)) return true
  }
  return false
}

/** 未命中任何规则时的空结果。 */
const NO_RULE = { matched: false, selectors: [], excludeSelectors: [], ruleId: null }

/**
 * 选出命中页面的第一条用户规则。
 * @param {string} url - 页面 URL。
 * @param {unknown} rules - `{ id?, matches, selectors?, excludeSelectors? }[]`。
 * @returns {{ matched: boolean, selectors: string[], excludeSelectors: string[], ruleId: string | null }} 命中结果。
 */
export function resolveRule(url, rules) {
  if (!Array.isArray(rules)) return NO_RULE
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object') continue
    if (!matchUrl(url, rule.matches)) continue
    const pick = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [])
    return {
      matched: true,
      selectors: pick(rule.selectors),
      excludeSelectors: pick(rule.excludeSelectors),
      ruleId: typeof rule.id === 'string' ? rule.id : null,
    }
  }
  return NO_RULE
}

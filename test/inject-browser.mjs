/**
 * 就地注入引擎的真实浏览器测试。
 *
 * 这是本插件的**验收测试**：它验证的行为就是用户要的东西——译文真的替换掉页面上的
 * 文字、悬停能看回原文、还原后一字不差、链接与行内代码不丢。
 *
 * 用真 Chromium + 真 DOM 跑，不用 DOM 桩：注入引擎的成败几乎全在"真实 DOM 边界行为"
 * （文本节点边界、内联元素搬移、MutationObserver、React 式重渲染）上，桩测不出这些。
 *
 * 被测的是 `lib/client.js` 里的引擎，通过一个最小 loader 把它注入页面，
 * 再用 `page.route` 假宿主 API（这样测试不依赖真实模型，快且可重复）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const require = createRequire(import.meta.url)

// playwright 装在 DSH profile 的 node_modules 里，不在本包依赖中。
// 路径按 DSH_HOME/HOME 推导，避免把开发机的绝对路径提交进公开仓库。
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const PLAYWRIGHT_PATHS = [
  'playwright',
  process.env.DSH_PLAYWRIGHT_PATH ?? '',
  process.env.PLAYWRIGHT_PATH ?? '',
  join(dshHome, 'profiles', 'desktop', 'node_modules', 'playwright'),
  join(dshHome, 'node_modules', 'playwright'),
].filter((p) => p !== '')
let chromium = null
for (const path of PLAYWRIGHT_PATHS) {
  try {
    chromium = require(path).chromium
    break
  } catch {
    /* 试下一个 */
  }
}
if (chromium === null) {
  console.error('SKIP: 找不到 playwright，无法跑真实浏览器测试')
  process.exit(0)
}

let passed = 0
/** 跑一条断言并计数。 */
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${String(passed)} - ${name}`)
}

/** 假宿主：按 id 返回固定译文，用于可重复验证。 */
const FAKE_TRANSLATIONS = {
  'Hello world': '你好，世界',
  'This is a paragraph with a link inside it': '这是一个包含链接的段落',
  'click here': '点这里',
  'Use npm install to install': '用 npm install 来安装',
  'bold text': '粗体文字',
}

/**
 * 造一条假译文。
 *
 * 块条目送来的 text 里含内联元素占位符（`[[§0]]`），所以不能拿整串去查表——
 * 真模型会把占位符原样带回来，这里就照同样口径处理：按"去掉占位符后的文字"
 * 查表，命中后把占位符按原顺序附回，保证 applyTo 能精确重建内联元素。
 * @param {string} text - 待译文本（可能含占位符）。
 * @returns {string} 假译文。
 */
function fakeTranslate(text) {
  const placeholders = [...text.matchAll(/\[\[\u00a7\d+\]\]/g)].map((match) => match[0])
  const bare = text.replace(/\[\[\u00a7\d+\]\]/g, '').replace(/\s+/g, ' ').trim()
  const body = FAKE_TRANSLATIONS[bare] ?? `【译】${bare.slice(0, 60)}`
  return placeholders.length === 0 ? body : `${body}${placeholders.join('')}`
}

const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/**
 * 找本机实际存在的 Chromium。
 *
 * playwright 包版本要求的 build 不一定已下载（本机 1.63 要 1243，但只装了 1223/1234），
 * 所以不依赖它自动解析，直接扫缓存目录挑一个能跑的。
 * @returns {string | undefined} 可执行文件路径；找不到则 undefined，交给 playwright 自解析。
 */
function findExecutable() {
  const home = process.env.HOME ?? ''
  const cache = join(home, 'Library', 'Caches', 'ms-playwright')
  let names = []
  try {
    names = readdirSync(cache).filter((name) => name.startsWith('chromium')).sort().reverse()
  } catch {
    return undefined
  }
  for (const name of names) {
    for (const candidate of [
      join(cache, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
      join(cache, name, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cache, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 夹具页：覆盖纯文本段、内联链接、加粗、行内代码、跳过区、列表。 */
/** 基础夹具。 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>
    <h1>Hello world</h1>
    <p id="plain">Hello world</p>
    <p id="withlink">This is a paragraph with a link inside it <a href="https://example.com/">click here</a></p>
    <p id="withcode">Use <code>npm install</code> to install</p>
    <p id="withbold">This is a paragraph with a <strong>bold text</strong> inside</p>
    <div id="skipme" translate="no"><p>Hello world</p></div>
    <ul><li id="li1">Hello world</li></ul>
    <div style="display:contents"><div style="display:contents"><p id="contents1">Hello world</p></div></div>
    <p id="already-zh">这是一段中文界面文案</p>
    <p id="mixed-en">Click the 设置 button to open the repository</p>
    <p id="mixed-en2">Hello 世界</p>
    <div id="shell" style="display:flex"><div style="display:flex"><span id="deep1">Hello world</span></div></div>
  </body></html>`

// 页面必须有真实同源 origin：`setContent` 落在 about:blank，相对 URL 的 fetch 会直接
// 抛 "Failed to parse URL"，把环境问题伪装成引擎 bug。所以起一个本地服务来承载夹具。
/**
 * 长页夹具：块数远超单轮扫描上限（240）。
 *
 * 这是真实会话的形状——对话 + 思维链会有几百个叶子块。早期实现把单轮上限当成
 * 总量上限，结果 539 叶块的会话里 98 个纯英文块只翻了 2 个（思维链全被挤掉）。
 * @param {number} count - 生成的段落数。
 * @returns {string} HTML。
 */
function longFixture(count) {
  const rows = []
  for (let i = 0; i < count; i += 1) rows.push(`<p id="row${String(i)}">English paragraph number ${String(i)} for the long page test.</p>`)
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${rows.join('')}</body></html>`
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(req.url.startsWith('/long') ? longFixture(600) : FIXTURE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${String(server.address().port)}`

const browser = await chromium.launch({ executablePath: findExecutable() })
const page = await browser.newPage()

/**
 * 装上"标准假宿主"：不碰真实模型，让引擎行为本身可重复验证。
 *
 * 提成函数是为了让用例可以 unroute 换一套假宿主之后再恢复，不必假设
 * "上一条用例留下的 route 还在"（那种隐式顺序依赖很容易被后续改动踩坏）。
 * @param {object} [options] - { hostProtocol } 传 null 表示模拟旧宿主；
 *   { config } 可覆盖返回给客户端的配置。
 * @returns {Promise<void>}
 */
async function useStandardHost(options = {}) {
  const hostProtocol = options.hostProtocol === undefined ? 2 : options.hostProtocol
  const extraConfig = options.config ?? {}
  await page.route('**/api/dsh-immersive-translate/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/settings')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          // 协议版本：客户端据此判断宿主是否为新代码，旧宿主会被拦下不翻。
          ...(hostProtocol === null ? {} : { hostProtocol }),
          config: { targetLanguage: 'zh-CN', displayMode: 'translation', autoTranslate: false, showBall: true, freeConcurrency: 4, batchChars: 3500, concurrency: 1, userRules: [], ...extraConfig },
          languages: [{ id: 'zh-CN', label: '中文（简体）' }],
        }),
      })
      return
    }
    if (url.includes('/batch')) {
      const body = JSON.parse(route.request().postData() ?? '{}')
      const translations = {}
      for (const item of body.items ?? []) {
        translations[item.id] = fakeTranslate(item.text)
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations, failed: 0, total: (body.items ?? []).length }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, text: '划词译文' }) })
  })
}

try {
  await useStandardHost()
  await page.goto(ORIGIN)

  // 最小 loader：把 client.js 跑起来，取出工厂产物并调用 apply。
  await page.addScriptTag({
    content: `
      window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };
      window.__applied = null;
    `,
  })
  await page.addScriptTag({ content: clientSource })
  await page.evaluate(() => {
    const mod = window.__entry.factory((name) => {
      if (name === 'react') {
        return {
          createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
          useRef: (v) => ({ current: v }),
          useEffect: () => undefined,
        }
      }
      throw new Error(`unexpected require: ${name}`)
    })
    const effects = []
    const ctx = {
      effect(factory, label) {
        effects.push(label)
        const dispose = factory()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      slots: { inject: () => () => {}, register: () => () => {} },
      get: () => undefined,
    }
    mod.apply(ctx)
    window.__applied = mod
    window.__effects = effects
  })

  /** 点一下右下角的悬浮开关并等译文落地。 */
  /** 点悬浮球展开操作条，再点操作项；`label` 为操作文案。 */
  const clickBallAction = async (label) => {
    // 操作条可能已展开（上一次点击留下的）；只在没显示时才点球，保证幂等。
    if (!(await page.isVisible('.imt-menu'))) await page.click('.imt-ball')
    const target = page.locator('.imt-menu-item', { hasText: label })
    await target.waitFor({ state: 'visible' })
    await target.click()
  }
  /**
   * 确保翻译处于开启状态并等结果落地。
   *
   * 操作条是状态相关的：已开启时只有「还原原文」，所以不能无脑点「翻译此页」。
   * @returns {Promise<void>} 就绪。
   */
  const enable = async () => {
    const state = await page.getAttribute('.imt-ball-wrap', 'data-state')
    if (state !== 'done' && state !== 'busy') await clickBallAction('翻译此页')
    await page.waitForTimeout(1400)
  }

  await check('悬浮控制条挂在页面上，初始文案是「翻译此页」', async () => {
    // 原版形态：右边缘圆形悬浮球（不是写着字的按钮）。
    assert.ok(await page.$('.imt-ball'), '悬浮球必须存在')
    assert.equal(await page.getAttribute('.imt-ball-wrap', 'data-state'), 'idle')
    // 默认贴右边缘竖直居中
    const wrapClass = await page.getAttribute('.imt-ball-wrap', 'class')
    assert.match(wrapClass ?? '', /imt-ball-right/)
  })

  // 触发翻译（await 在下面用断言等结果）。
  await enable()

  await check('纯文本段落：原文被译文就地替换（不是另开面板）', async () => {
    const text = await page.textContent('#plain')
    assert.equal(text?.trim(), '你好，世界')
  })

  await check('标题也被翻译', async () => {
    const text = await page.textContent('h1')
    assert.equal(text?.trim(), '你好，世界')
  })

  await check('内联链接：文字被翻译，<a> 元素与 href 完整保留', async () => {
    const anchor = await page.$('#withlink a')
    assert.ok(anchor !== null, 'link element must survive')
    assert.equal((await anchor.textContent())?.trim(), '点这里')
    assert.equal(await anchor.getAttribute('href'), 'https://example.com/')
    const p = await page.textContent('#withlink')
    assert.match(p ?? '', /这是一个包含链接的段落/)
  })

  await check('行内 <code>：元素保留（不被译文拆掉），内部文字不翻译', async () => {
    const code = await page.$('#withcode code')
    assert.ok(code !== null, 'code element must survive')
    assert.equal((await code.textContent())?.trim(), 'npm install')
  })

  await check('行内 <strong>：元素保留，内部文字被翻译', async () => {
    const strong = await page.$('#withbold strong')
    assert.ok(strong !== null, 'strong element must survive')
    assert.equal((await strong.textContent())?.trim(), '粗体文字')
  })

  await check('列表项也被翻译', async () => {
    assert.equal((await page.textContent('#li1'))?.trim(), '你好，世界')
  })

  await check('translate="no" 区域保持原文', async () => {
    assert.equal((await page.textContent('#skipme p'))?.trim(), 'Hello world')
  })

  await check('悬停译文块时浮出原文', async () => {
    await page.hover('#plain')
    await page.waitForTimeout(120)
    const open = await page.getAttribute('.imt-tip', 'data-open')
    const text = await page.textContent('.imt-tip')
    assert.equal(open, '1', 'tooltip must open on hover')
    assert.equal(text?.trim(), 'Hello world')
  })

  // 真实 DSH 界面大量使用 display:contents 包裹层与 flex 嵌套。早期实现把它们当成
  // 一个超长叶子块（整页 243 字一块），实测只翻出 3 块混杂界面文案；这两条守住修复。
  await check('display:contents 包裹层会被穿透，内部段落照常翻译', async () => {
    assert.equal((await page.textContent('#contents1'))?.trim(), '你好，世界')
  })

  await check('flex 嵌套里的叶子文本也能被找到并翻译', async () => {
    assert.equal((await page.textContent('#deep1'))?.trim(), '你好，世界')
  })

  // 目标已是中文时，中文内容不该再送模型：白烧 token，还可能被模型改写坏。
  await check('目标语言是中文时，中文内容被跳过（不发起翻译、保持原样）', async () => {
    const text = await page.textContent('#already-zh')
    assert.equal(text?.trim(), '这是一段中文界面文案')
    // 关键：它不该被打上"已翻译"标记——没翻就是没翻，不要假装翻过。
    assert.equal(await page.getAttribute('#already-zh', 'data-imt-done'), null)
  })

  await check('夹了中文的英文句子仍然会被翻译（只跳过纯中文）', async () => {
    // 真 bug：旧实现先 `replace(/[A-Za-z][A-Za-z0-9_.-]*/g,' ')` 把英文单词整段删掉
    // 再统计拉丁词，导致 latinWords 恒为 0 → 任何含汉字的句子都算成 100% 中文、
    // 整句被跳过。用户实测："Click the 设置 button to open the repository" 永不被翻。
    // 用户的期望很明确：**只跳过纯中文，不跳过含中文的句子**。
    const mixed = (await page.textContent('#mixed-en'))?.trim() ?? ''
    assert.ok(mixed.startsWith('【译】'), `夹中文的英文句必须被翻译，实际="${mixed}"`)
    const mixed2 = (await page.textContent('#mixed-en2'))?.trim() ?? ''
    assert.ok(mixed2.startsWith('【译】'), `"Hello 世界" 必须被翻译，实际="${mixed2}"`)
    // 同时不能把纯中文也送去翻（否则等于没过滤）。
    assert.equal(await page.getAttribute('#already-zh', 'data-imt-done'), null, '纯中文仍应被跳过')
  })

  await check('流式新内容会自动补翻（MutationObserver）', async () => {
    await page.evaluate(() => {
      const p = document.createElement('p')
      p.id = 'late'
      p.textContent = 'Hello world'
      document.body.append(p)
    })
    await page.waitForTimeout(1600)
    assert.equal((await page.textContent('#late'))?.trim(), '你好，世界')
  })

  await check('再点一次：还原原文，且结构一字不差（含链接与 code）', async () => {
    await clickBallAction('还原原文')
    await page.waitForTimeout(400)
    assert.equal((await page.textContent('#plain'))?.trim(), 'Hello world')
    assert.equal((await page.textContent('h1'))?.trim(), 'Hello world')
    assert.equal((await page.textContent('#li1'))?.trim(), 'Hello world')
    const html = await page.innerHTML('#withlink')
    assert.match(html, /This is a paragraph with a link inside it/)
    assert.match(html, /<a href="https:\/\/example\.com\/">click here<\/a>/)
    const codeHtml = await page.innerHTML('#withcode')
    assert.match(codeHtml, /Use <code>npm install<\/code> to install/)
    assert.equal(await page.$('.imt-insert'), null, '双语插入节点不应残留')
  })

  await check('双语模式：原文保留，译文插在其后', async () => {
    // 切到双语模式：直接改引擎读到的配置（引擎每轮都重新读）。
    await page.unroute('**/api/dsh-immersive-translate/**')
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hostProtocol: 2, config: { targetLanguage: 'zh-CN', displayMode: 'dual', autoTranslate: false, batchChars: 3500, concurrency: 1, userRules: [] }, languages: [] }) })
        return
      }
      const body = JSON.parse(route.request().postData() ?? '{}')
      const translations = {}
      for (const item of body.items ?? []) translations[item.id] = fakeTranslate(item.text)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations, failed: 0 }) })
    })
    // 上一项测试结束时引擎是关的，这里点一次开启即可（开启会重新取配置，
    // 所以刚改的 displayMode=dual 会生效）。
    await clickBallAction('翻译此页')
    await page.waitForTimeout(1600)
    // 双语模式下译文是**兄弟节点**（紧随原文），所以 #plain 自身保持原文。
    const original = await page.textContent('#plain')
    assert.equal(original?.trim(), 'Hello world', '双语模式下原文必须保留')
    const inserted = await page.$('.imt-insert')
    assert.ok(inserted !== null, '双语模式应插入译文节点')
    assert.equal((await inserted.textContent())?.trim(), '你好，世界')
  })

  await check('目标语言是英文时，中文内容会被翻译（语言判断不挡正常方向）', async () => {
    await page.unroute('**/api/dsh-immersive-translate/**')
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hostProtocol: 2, config: { targetLanguage: 'en', displayMode: 'translation', autoTranslate: false, batchChars: 3500, concurrency: 1, userRules: [] }, languages: [] }) })
        return
      }
      const body = JSON.parse(route.request().postData() ?? '{}')
      const translations = {}
      for (const item of body.items ?? []) translations[item.id] = `EN(${String(item.text).slice(0, 30)})`
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations, failed: 0 }) })
    })
    await page.goto(ORIGIN)
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    // 必须全新 boot：引擎在 mount 时读配置，沿用上一次的实例会拿旧 targetLanguage。
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await enable()
    const zh = (await page.textContent('#already-zh'))?.trim() ?? ''
    assert.ok(zh.startsWith('EN('), `中文内容应被翻译，实际="${zh}"`)
    // 英文原文在目标为英文时应被跳过
    assert.equal((await page.textContent('#plain'))?.trim(), 'Hello world')
  })

  // 开关状态不持久化时，刷新后永远回到关闭：用户点过翻译、切到别的页签却什么都没发生，
  // 而且毫无提示。这两条守住持久化与反馈。
  await check('开关状态被记忆：刷新后自动恢复翻译', async () => {
    await page.unroute('**/api/dsh-immersive-translate/**')
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hostProtocol: 2, config: { targetLanguage: 'zh-CN', displayMode: 'translation', autoTranslate: false, batchChars: 3500, concurrency: 1, userRules: [] }, languages: [] }) })
        return
      }
      const body = JSON.parse(route.request().postData() ?? '{}')
      const translations = {}
      for (const item of body.items ?? []) translations[item.id] = fakeTranslate(item.text)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations, failed: 0 }) })
    })
    // 先开启（此时会写入 localStorage）
    await page.goto(ORIGIN)
    // 必须在 boot 之前清：插件是在 apply 时读这个键的。
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    const boot = async () => {
      await page.evaluate(() => {
        const mod = window.__entry.factory((name) => {
          if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
          throw new Error(`unexpected require: ${name}`)
        })
        mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
      })
    }
    await boot()
    await enable()
    const saved = await page.evaluate(() => localStorage.getItem('dsh-immersive-translate:enabled:v1'))
    assert.equal(saved, '1', '开启后应写入 localStorage')

    // 重新加载页面（等价于刷新/重启），应自动恢复为开启并翻译
    await page.goto(ORIGIN)
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await boot()
    await page.waitForTimeout(1600)
    const state = await page.getAttribute('.imt-ball-wrap', 'data-state')
    assert.equal(state, 'done', '刷新后应自动恢复为已翻译状态')
    assert.equal((await page.textContent('#plain'))?.trim(), '你好，世界')
  })

  await check('点翻译后给出明确反馈（提示条），不让人分不清"没内容"和"坏了"', async () => {
    // 自成一体：从干净页面开始，点一次翻译，再等过提示条的延时窗口（约 3.5s）。
    // 不能依赖上一个用例的副作用——它的时序会变。
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await clickBallAction('翻译此页')
    await page.waitForTimeout(4200)
    const shown = await page.evaluate(() => {
      const t = document.querySelector('.imt-toast')
      return t ? { show: t.getAttribute('data-show'), text: t.textContent } : null
    })
    assert.ok(shown !== null, '提示条必须存在')
    assert.equal(shown.show, '1', '提示条应当显示')
    assert.ok((shown.text ?? '').length > 0, '提示条必须有内容')
  })

  await check('旧宿主（未上报协议版本）会被拦下，绝不偷偷走用户自己的模型', async () => {
    // 宿主代码改动必须重启 DSH 才生效：若客户端先更新，界面是新的、翻译却仍走旧链路
    // （消耗用户模型额度）。这条用例守住"宁可不翻，也不偷偷花额度"。
    await page.unroute('**/api/dsh-immersive-translate/**')
    let batchCalls = 0
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        // 旧宿主：不返回 hostProtocol
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, config: { targetLanguage: 'zh-CN', displayMode: 'translation' }, languages: [{ id: 'zh-CN', label: '中文（简体）' }] }) })
      }
      if (url.includes('/batch')) batchCalls += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations: {}, total: 0, failed: 0 }) })
    })
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await page.waitForTimeout(400)
    if (!(await page.isVisible('.imt-menu'))) await page.click('.imt-ball')
    await page.locator('.imt-menu-item', { hasText: '翻译此页' }).click()
    await page.waitForTimeout(1200)
    const after = await page.evaluate(() => ({
      state: document.querySelector('.imt-ball-wrap')?.getAttribute('data-state'),
      enabled: localStorage.getItem('dsh-immersive-translate:enabled:v1'),
      toast: document.querySelector('.imt-toast')?.textContent ?? '',
      toastShow: document.querySelector('.imt-toast')?.getAttribute('data-show'),
    }))
    assert.equal(batchCalls, 0, '旧宿主下不得发起任何翻译请求（否则会走用户自己的模型）')
    assert.notEqual(after.state, 'done', '旧宿主下不得进入已翻译状态')
    assert.equal(after.enabled, '0', '旧宿主下开关必须回到关闭，避免下次进来又悄悄翻')
    assert.equal(after.toastShow, '1', '必须浮出提示条')
    assert.match(after.toast, /重启 DSH/, '提示必须说清怎么解决')
    // 复原成标准假宿主，后面的用例继续用（显式恢复，不依赖隐式顺序）。
    await page.unroute('**/api/dsh-immersive-translate/**')
    await useStandardHost()
  })

  await check('占位符必须能被真机器翻译原样保留（旧标记 ⟦n⟧ 会被腾讯改写）', async () => {
    // 这是本轮实测踩到的真问题：旧占位符 ⟦0⟧ 被腾讯交互翻译改写
    //   "GitHub⟦0⟧"              → "GitHub下载"
    //   "Click here⟦0⟧now please" → "请点击这里"   （占位符整段消失 → <a> 被丢）
    // 原来的测试用假宿主，假宿主只做字符串拼接、永远保留占位符，所以漏检。
    // 这里直接对**真实服务**验标记形态：属于少量"必须打真网络"的用例。
    const probes = [
      'GitHub[[§0]]',
      'Click here[[§0]]now please',
      '[[§0]]Click here now',
      'Read[[§0]]this[[§1]]now',
      ['line1', '[[§0]]', 'line3'].join('\n'),
    ]
    let response = null
    try {
      response = await fetch('https://transmart.qq.com/api/imt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0', device_type: 'web' },
          type: 'plain',
          source: { lang: 'auto', text_list: probes },
          target: { lang: 'zh' },
        }),
      })
    } catch (error) {
      // 网络不可达时跳过（本机对部分域名确实不通），但不能把"没测"说成"通过"。
      console.log(`    (跳过：真实服务不可达 ${String(error.message).slice(0, 60)})`)
      return
    }
    if (!response.ok) {
      console.log(`    (跳过：真实服务返回 HTTP ${String(response.status)})`)
      return
    }
    const payload = await response.json()
    const list = payload?.auto_translation
    if (!Array.isArray(list)) {
      console.log('    (跳过：真实服务未返回数组)')
      return
    }
    const marker = /\[\[\u00a7\d+\]\]/g
    probes.forEach((source, index) => {
      const got = list[index] ?? ''
      const expected = [...source.matchAll(marker)].map((m) => m[0])
      for (const token of expected) {
        assert.ok(got.includes(token), `占位符 ${token} 被机器翻译改写了：${JSON.stringify(source)} → ${JSON.stringify(got)}`)
      }
    })
  })

  await check('划词翻译能用：选中文字 → 点「译」→ 浮出译文（不走已废弃的 readJson 作用域）', async () => {
    await page.goto(ORIGIN)
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    const errs = []
    page.on('pageerror', (error) => errs.push(String(error.message)))
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    // 选中 #plain 的文本，触发划词按钮
    await page.evaluate(() => {
      const node = document.querySelector('#plain')
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.waitForTimeout(600)
    const buttonVisible = await page.isVisible('.imt-sel')
    assert.ok(buttonVisible, '选中文字后必须浮出划词按钮')
    await page.click('.imt-sel')
    await page.waitForTimeout(900)
    const pop = await page.textContent('.imt-pop')
    assert.ok(pop && pop.includes('划词译文'), `划词译文应显示出来，实际=${String(pop)}`)
    assert.deepEqual(errs, [], `划词路径不得抛异常，实际=${JSON.stringify(errs.slice(0, 2))}`)
  })

  await check('样式表被误删后，悬浮球仍在视口内、菜单仍可点（开关不会"不见"）', async () => {
    // 真事故（2026-09-25 桌面端）：DSH 模块系统物化插件时会把所有
    // `style:not([data-plugin])` 认领到当前插件名下，该插件热重载时再全部删掉
    // （dsh-client-modules/lib/client.js 的 claimStyles / removeOwnedStyles）。
    // 本插件样式表若在热重载窗口里缺失，`.imt-ball-wrap` 会从 fixed 退化成 static，
    // 球被挤到文档末尾（实测 top 380 → 800，正好落在视口外）——表现为
    // "悬浮球/开关不见了"。这条用例守住"任何样式表丢失都不影响可见与可点"。
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await page.waitForTimeout(400)

    const probe = () => page.evaluate(() => {
      const wrap = document.querySelector('.imt-ball-wrap')
      const r = wrap?.getBoundingClientRect()
      const menu = document.querySelector('.imt-menu')
      const tip = document.querySelector('.imt-tip')
      return {
        pos: wrap ? getComputedStyle(wrap).position : null,
        top: r ? Math.round(r.top) : null,
        left: r ? Math.round(r.left) : null,
        visible: r ? r.width > 0 && r.top >= -1 && r.top < innerHeight && r.left >= -1 && r.left < innerWidth : false,
        docScroll: document.documentElement.scrollHeight,
        innerH: innerHeight,
        scrollable: document.documentElement.scrollHeight > innerHeight + 1,
        menuDisplayWhenClosed: menu ? getComputedStyle(menu).display : null,
        tipDisplay: tip ? getComputedStyle(tip).display : null,
      }
    })

    const before = await probe()
    assert.equal(before.pos, 'fixed', '正常情况下悬浮球应为 fixed')
    assert.ok(before.visible, '正常情况下悬浮球应在视口内')
    assert.equal(before.scrollable, false, '正常情况下主界面不应可滚动')

    // 复刻事故：删掉本插件注入的样式表
    await page.evaluate(() => document.getElementById('imt-style')?.remove())
    await page.waitForTimeout(200)
    const after = await probe()
    assert.equal(after.pos, 'fixed', '样式表丢失后悬浮球必须仍为 fixed（内联兜底）')
    assert.ok(after.visible, `样式表丢失后悬浮球必须仍在视口内，实际 top=${String(after.top)} left=${String(after.left)}`)
    assert.equal(after.scrollable, false, `样式表丢失后主界面不得可滚动，实际 ${String(after.docScroll)} vs ${String(after.innerH)}`)

    // 样式表没了，球还得能点开菜单（开关可用）
    const opened = await page.evaluate(async () => {
      const ball = document.querySelector('.imt-ball')
      const r = ball.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const mk = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0 })
      ball.dispatchEvent(mk('pointerdown'))
      ball.dispatchEvent(mk('pointerup'))
      await new Promise((res) => setTimeout(res, 300))
      const menu = document.querySelector('.imt-menu')
      const sw = document.querySelector('.imt-switch-row')
      return {
        display: getComputedStyle(menu).display,
        items: [...menu.querySelectorAll('.imt-menu-item')].map((i) => i.textContent),
        visible: menu.getBoundingClientRect().height > 0,
        // 用户反馈"开关不见了"：必须有显式拨杆开关，而不是只在菜单项文案上隐式表达。
        switchExists: !!sw,
        switchVisible: sw ? sw.getBoundingClientRect().height > 0 : false,
        switchRole: sw?.getAttribute('role') ?? null,
        switchAria: sw?.getAttribute('aria-checked') ?? null,
        switchText: sw?.querySelector('.imt-switch-label')?.textContent ?? null,
      }
    })
    assert.equal(opened.display, 'flex', '样式表丢失后菜单仍须能展开')
    assert.ok(opened.visible, '菜单须可见')
    assert.ok(opened.items.some((t) => t.includes('翻译此页') || t.includes('还原原文')), `菜单里必须有翻译开关项，实际=${JSON.stringify(opened.items)}`)
    assert.ok(opened.switchExists, '悬浮球菜单里必须有显式开关（用户反馈"开关不见了"）')
    assert.ok(opened.switchVisible, '样式表丢失后开关仍须可见')
    assert.equal(opened.switchRole, 'switch', '开关应有 role=switch（可访问性）')
    assert.ok(opened.switchAria === 'true' || opened.switchAria === 'false', '开关应有 aria-checked 状态')
    assert.match(opened.switchText ?? '', /翻译已(开启|关闭)/, `开关文案应明确表达状态，实际=${String(opened.switchText)}`)

    // 恢复：把样式表加回来，避免影响后续用例
    await page.evaluate(() => {
      if (!document.getElementById('imt-style')) {
        const wrap2 = document.querySelector('.imt-ball-wrap')
        // 触发一次 ensureStyles：重新挂载模块代价大，这里直接重建样式表即可
        const st = document.createElement('style')
        st.id = 'imt-style'
        st.setAttribute('data-plugin', '@dsh-external/dsh-immersive-translate')
        document.head.appendChild(st)
        wrap2?.classList.add('imt-ball-right')
      }
    })
  })

  await check('「打开页面自动翻译」开启后，一进页面不用点球就自动翻', async () => {
    // 真 bug：autoTranslate 原先没登记在宿主 DEFAULTS 里，落盘被白名单丢弃，
    // 刷新即失效 —— 用户看到的就是"这个功能不生效"。这条用例守住端到端生效。
    await page.unroute('**/api/dsh-immersive-translate/**')
    await useStandardHost({ config: { autoTranslate: true } })
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    // 全程不点悬浮球，只等自动翻译跑完
    await page.waitForTimeout(2500)
    const auto = await page.evaluate(() => ({
      state: document.querySelector('.imt-ball-wrap')?.getAttribute('data-state'),
      text: document.querySelector('#plain')?.textContent,
      done: document.querySelectorAll('[data-imt-done]').length,
    }))
    assert.ok(auto.done > 0, `自动翻译应真的翻出块来，实际 state=${String(auto.state)} text=${String(auto.text)}`)
    // 不断言具体译文：夹具里 "Hello world" 有固定假译文，断言前缀会与假宿主耦合。
    assert.notEqual(auto.text?.trim(), 'Hello world', `自动翻译必须真的改掉页面原文，实际="${String(auto.text)}"`)
  })

  await check('「悬浮球」开关能隐藏/显示悬浮球（且不影响翻译）', async () => {
    await page.unroute('**/api/dsh-immersive-translate/**')
    await useStandardHost({ config: { showBall: false } })
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await page.waitForTimeout(1200)
    const hidden = await page.evaluate(() => {
      const w = document.querySelector('.imt-ball-wrap')
      return { exists: !!w, display: w ? getComputedStyle(w).display : null, rectW: w ? Math.round(w.getBoundingClientRect().width) : null }
    })
    assert.ok(hidden.exists, '隐藏时仍要保留 DOM（否则引擎状态监听会断）')
    assert.equal(hidden.display, 'none', 'showBall=false 时悬浮球必须隐藏')
    assert.equal(hidden.rectW, 0, '隐藏时不应占位')
    // 恢复默认，避免影响后续用例
    await page.unroute('**/api/dsh-immersive-translate/**')
    await useStandardHost()
  })

  await check('设置面板能挂载，且翻译引擎默认是自带免费服务', async () => {
    // 用一个极简 hooks 运行时把设置面板真挂出来：这样"引擎下拉默认值"是可验证的，
    // 而不是只检查源码里有没有那行字。
    await page.goto(ORIGIN)
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    const mounted = await page.evaluate(() => {
      const hookState = []
      let hookIndex = 0
      const effects = []
      const React = {
        useRef: (v) => { const i = hookIndex++; if (!hookState[i]) hookState[i] = { current: v }; return hookState[i] },
        useState: (v) => { const i = hookIndex++; if (!hookState[i]) hookState[i] = { value: v }; return [hookState[i].value, () => {}] },
        useEffect: (fn, deps) => { const i = hookIndex++; const prev = hookState[i]; const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k]); if (changed) { hookState[i] = { deps }; effects.push(fn) } },
        Fragment: 'div',
        createElement: (tag, props, ...kids) => {
          const all = { ...(props ?? {}), children: kids.length ? (kids.length === 1 ? kids[0] : kids) : undefined }
          if (typeof tag === 'function') return tag(all)
          const node = document.createElement(tag)
          for (const [k, v] of Object.entries(all)) {
            if (k === 'children') continue
            if (k === 'ref') { if (typeof v === 'function') v(node); else if (v && typeof v === 'object') v.current = node; continue }
            if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2).toLowerCase(), v); continue }
            if (k === 'style') { Object.assign(node.style, v); continue }
            if (k === 'class' || k === 'className') { node.className = v; continue }
            if (v === true) node.setAttribute(k, '')
            else if (v !== undefined && v !== false && v !== null) node.setAttribute(k, String(v))
          }
          const list = Array.isArray(all.children) ? all.children : all.children === undefined ? [] : [all.children]
          for (const kid of list.flat(Infinity)) {
            if (kid === undefined || kid === null || kid === false || kid === true) continue
            node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
          }
          return node
        },
      }
      const views = []
      const slots = { inject: (_n, cb) => cb(), register: (meta, view) => { views.push({ meta, view }); return () => {} } }
      window.__entry.factory((n) => { if (n === 'react') return React; throw new Error(`unexpected require: ${n}`) }).apply({ effect: (f) => f(), slots, get: () => undefined })
      hookIndex = 0
      effects.length = 0
      const node = views[0].view(React)
      document.body.append(node)
      for (const fn of effects) fn()
      return {
        rows: document.querySelectorAll('.imt-set-row').length,
        hasPassword: document.querySelectorAll('input[type=password]').length > 0,
        engine: document.querySelector('select.imt-in')?.value ?? null,
        services: document.querySelectorAll('.imt-svc').length,
        // 设置页里的拨杆开关数量（「自动翻译」「悬浮球」各一个）。
        switches: document.querySelectorAll('.imt-set .imt-switch-row').length,
        // 「模型提供方 / 模型 ID」输入框应已移除（翻译走自带免费服务）。
        hasModelInputs: [...document.querySelectorAll('.imt-set input')].some((i) => (i.placeholder ?? '').includes('DSH 默认模型')),
      }
    })
    assert.ok(mounted.rows >= 10, `设置面板应有足够多的设置项，实际 ${String(mounted.rows)} 行`)
    assert.ok(mounted.hasPassword, '必须有账号令牌输入框')
    // 两个开关必须在设置页里（用户明确要求"打开页面自动翻译做成开关"）。
    assert.ok(mounted.switches >= 2, `设置页至少要有「自动翻译」「悬浮球」两个开关，实际 ${String(mounted.switches)}`)
    // 模型行必须删掉：翻译走的是沉浸式翻译自带的免费服务，不再用 DSH 的模型。
    assert.equal(mounted.hasModelInputs, false, '设置页不应再有「模型提供方 / 模型 ID」输入框')
    // 关键：默认引擎不能是 dsh-model（那会花用户自己的额度）。
    assert.equal(mounted.engine, 'auto', '翻译引擎默认应为自带免费服务')
    assert.equal(mounted.services, 1, '必须有"免费服务自检"入口')
  })

  await check('保存开关后不会"弹回原位"（宿主还不认这些键时靠本地镜像兜底）', async () => {
    // 真 bug：曾把本地镜像写在 load() 之后，于是首次保存时 load() 回填读到的是
    // 还没更新的镜像 → 开关视觉上弹回原位。用户会以为"开关点了没用"。
    // 这里用一个**不认 autoTranslate/showBall 的宿主**（模拟未重启的旧宿主）来复现。
    await page.unroute('**/api/dsh-immersive-translate/**')
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        if (route.request().method() === 'POST') {
          // 旧宿主：保存成功，但白名单把新键过滤掉，返回的 config 里没有它们。
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, config: { targetLanguage: 'zh-CN', displayMode: 'translation', batchChars: 3500, concurrency: 1, userRules: [] } }) })
          return
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hostProtocol: 2, config: { targetLanguage: 'zh-CN', displayMode: 'translation', batchChars: 3500, concurrency: 1, userRules: [] }, languages: [{ id: 'zh-CN', label: '中文' }] }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations: {}, total: 0, failed: 0 }) })
    })
    await page.goto(ORIGIN)
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:prefs:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    // 设置面板由插件自己注册；这里直接把注册的 view 挂出来，省去 React。
    const result = await page.evaluate(async () => {
      const effects = []
      const React = {
        useRef: (v) => ({ current: v }),
        useState: (v) => [v, () => {}],
        useEffect: (fn) => { effects.push(fn) },
        createElement: (tag, props, ...kids) => {
          const all = { ...(props ?? {}), children: kids.length ? (kids.length === 1 ? kids[0] : kids) : undefined }
          if (typeof tag === 'function') return tag(all)
          const node = document.createElement(tag)
          for (const [k, v] of Object.entries(all)) {
            if (k === 'children') continue
            if (k === 'ref') { if (typeof v === 'function') v(node); else if (v && typeof v === 'object') v.current = node; continue }
            if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2).toLowerCase(), v); continue }
            if (k === 'style') { Object.assign(node.style, v); continue }
            if (k === 'class' || k === 'className') { node.className = v; continue }
            if (v === true) node.setAttribute(k, '')
            else if (v !== undefined && v !== false && v !== null) node.setAttribute(k, String(v))
          }
          const list = Array.isArray(all.children) ? all.children : all.children === undefined ? [] : [all.children]
          for (const kid of list.flat(Infinity)) {
            if (kid === undefined || kid === null || kid === false || kid === true) continue
            node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
          }
          return node
        },
      }
      const views = []
      const slots = { inject: (_n, cb) => cb(), register: (meta, view) => { views.push({ meta, view }); return () => {} } }
      window.__entry.factory((n) => { if (n === 'react') return React; throw new Error('req ' + n) }).apply({ effect: (f) => f(), slots, get: () => undefined })
      document.body.append(views[0].view(React))
      // 设置面板是在 SettingsView 的 effect 里建的，必须把 effect 跑起来。
      for (const fn of effects) fn()
      await new Promise((r) => setTimeout(r, 800))

      const rows = [...document.querySelectorAll('.imt-set-row')]
      const autoRow = rows.find((r) => r.querySelector('.imt-set-label')?.textContent === '打开页面自动翻译')
      const sw = autoRow.querySelector('.imt-switch-row')
      const before = sw.getAttribute('aria-checked')
      sw.click()
      await new Promise((r) => setTimeout(r, 100))
      const saveBtn = [...document.querySelectorAll('.imt-set button')].find((b) => b.textContent === '保存')
      saveBtn.click()
      await new Promise((r) => setTimeout(r, 900))
      return {
        点击前: before,
        保存后: sw.getAttribute('aria-checked'),
        镜像: JSON.parse(window.localStorage.getItem('dsh-immersive-translate:prefs:v1') ?? '{}'),
      }
    })
    assert.equal(result.点击前, 'false', '初始应为关闭')
    assert.equal(result.点击后 ?? result.保存后, 'true', `保存后开关必须保持开启（不能弹回），实际=${String(result.保存后)}`)
    assert.equal(result.镜像.autoTranslate, true, '本地镜像必须记下 autoTranslate=true')
    await page.unroute('**/api/dsh-immersive-translate/**')
    await useStandardHost()
  })

  await check('用户规则的 excludeSelectors 能跳过指定区域', async () => {
    await page.unroute('**/api/dsh-immersive-translate/**')
    await page.route('**/api/dsh-immersive-translate/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/settings')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hostProtocol: 2, config: { targetLanguage: 'zh-CN', displayMode: 'translation', autoTranslate: false, batchChars: 3500, concurrency: 1, userRules: [{ excludeSelectors: ['#li1'] }] }, languages: [] }) })
        return
      }
      const body = JSON.parse(route.request().postData() ?? '{}')
      const translations = {}
      for (const item of body.items ?? []) translations[item.id] = fakeTranslate(item.text)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, translations, failed: 0 }) })
    })
    // 重置页面，重新走一轮。
    await page.goto(ORIGIN)
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    await enable()
    assert.equal((await page.textContent('#li1'))?.trim(), 'Hello world', 'excludeSelectors 命中的区域应保持原文')
    assert.equal((await page.textContent('#plain'))?.trim(), '你好，世界', '未命中区域应正常翻译')
  })
  // 真实会话有几百个叶子块（对话 + 思维链）。单轮 240 块的上限必须能继续推进，
  // 否则后面的内容永远翻不到——这是用户实际遇到的那个 bug。
  await check('超过单轮上限的长页（600 块）能全部翻完，不遗漏后半部分', async () => {
    await page.goto(`${ORIGIN}/long`)
    // 开关状态现在是持久化的：不清掉的话，上一个用例留下的 "已开启" 会让操作条
    // 只显示「还原原文」，这里就点不到「翻译此页」。
    await page.evaluate(() => localStorage.removeItem('dsh-immersive-translate:enabled:v1'))
    await page.addScriptTag({ content: `window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };` })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(() => {
      const mod = window.__entry.factory((name) => {
        if (name === 'react') return { createElement: (t, p, ...c) => ({ type: t, props: { ...p, children: c } }), useRef: (v) => ({ current: v }), useEffect: () => undefined }
        throw new Error(`unexpected require: ${name}`)
      })
      mod.apply({ effect: (f) => f(), slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined })
    })
    if (!(await page.isVisible('.imt-menu'))) await page.click('.imt-ball')
    await page.locator('.imt-menu-item', { hasText: '翻译此页' }).click()
    // 600 块 / 每批 24 条 / 2 并发，给足时间。
    await page.waitForTimeout(20000)
    const done = await page.evaluate(() => document.querySelectorAll('[data-imt-done]').length)
    assert.ok(done >= 590, `600 块里应几乎全翻，实际 ${String(done)}`)
    // 关键：最后一块（多轮扫描才会走到的、最容易漏的）必须也翻了。
    // 假宿主对未命中映射的文字加「【译】」前缀，所以断言"带前缀"即"被翻过"。
    const last = await page.textContent('#row599')
    assert.match(last ?? '', /^【译】/, `最后一块未被翻译：${String(last).slice(0, 60)}`)
    const first = await page.textContent('#row0')
    assert.match(first ?? '', /^【译】/, `第一块未被翻译：${String(first).slice(0, 60)}`)
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

console.log(`\n${String(passed)} browser checks passed`)

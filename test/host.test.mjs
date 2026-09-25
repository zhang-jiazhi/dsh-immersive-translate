/**
 * 宿主半集成测试。
 *
 * 用假 ctx / 假 llm 跑真实路由与真实翻译流程，验证的是行为而不是结构：
 *  - 路由的 loopback/same-origin 闸真的拒绝了跨站来源；
 *  - 翻译请求被正确组装成批、模型返回被正确解析回块；
 *  - 模型返回围栏 JSON / 跑偏格式时不会把整页翻译丢掉；
 *  - 不可翻译的块（代码、纯数字、隐藏元素）不进模型调用；
 *  - 设置写入落盘、再读回来仍然生效。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

/** 本测试文件所在目录（用于读 lib/index.js 做静态约束检查）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

// 设置文件路径由 DSH_HOME 推导，必须在 import 之前定下来。
const HOME = mkdtempSync(join(tmpdir(), 'imt-test-'))
process.env.DSH_HOME = HOME

const module = await import('../lib/index.js')

let passed = 0
/** 跑一条（可能异步的）断言并计数；失败即抛出，让进程以非零码退出。 */
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${String(passed)} - ${name}`)
}

/** 造一个最小的假 ctx：收集路由、工具与 llm 调用。 */
function makeCtx({ translation = null, failTimes = 0, selection = { provider: 'test-provider', model: 'test-model' }, strict = true } = {}) {
  const routes = new Map()
  const tools = []
  const calls = []
  let failures = failTimes
  /** 已经发生的未声明服务访问（用于断言 inject 声明完整）。 */
  const undeclaredAccess = []
  /** 假的 llm 服务（软读拿到的就是它）。 */
  const fakeLlm = {
    stream(options) {
      calls.push(options)
      const payload = options.messages[0].content[0].text
      const items = JSON.parse(payload.slice(payload.indexOf('[')))
      const out = translation !== null ? translation(items) : JSON.stringify(items.map((item) => ({ id: item.id, text: `译:${item.text}` })))
      // 模拟流式：分片吐出，验证聚合逻辑。
      return (async function* generate() {
        if (failures > 0) {
          failures -= 1
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'reasoning effort not supported', code: 'UNSUPPORTED_REASONING_EFFORT' } } }
          return
        }
        for (const chunk of out.match(/[\s\S]{1,16}/g) ?? []) yield { type: 'text-delta', index: 0, text: chunk }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(factory, label) {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
        void label
      }
    },
    get(name) {
      if (name === 'agentDefaultModel') return selection === null ? undefined : { currentSelection: () => selection }
      if (name === 'web') return undefined
      // 插件用软读拿 llm（免费服务是默认路径，llm 不在 inject 里）。
      if (name === 'llm') return ctx.__llm
      if (name === 'clientModules' || name === 'client-modules') return undefined
      return undefined
    },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    __llm: fakeLlm,
    __routes: routes,
    __tools: tools,
    __calls: calls,
    __undeclaredAccess: undeclaredAccess,
    __strict: strict,
  }
  // cordis 的 Context 是属性代理：访问**未在 inject 里声明**的服务属性会抛
  // `cannot get property "x" without inject` 并让整个 fiber 回滚。这里在假 ctx
  // 上复刻这个语义 —— 否则测试里 `ctx.tools` 随便访问都能过，真机上却整个插件挂不上
  // （2026-09-24 实测：inject 少写 'tools' → 4 条路由与 2 个工具全都没注册）。
  if (strict) {
    return new Proxy(ctx, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !prop.startsWith('__') && !(prop in target) && prop !== 'then') {
          undeclaredAccess.push(prop)
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }
  return ctx
}

/** 造一个假的 IncomingMessage（本机同源）。 */
function makeReq({ body = null, method = 'POST', origin = 'http://127.0.0.1:19387', host = '127.0.0.1:19387', address = '127.0.0.1', site = 'same-origin' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress: address }
  req.headers = { host, ...(origin === null ? {} : { origin }), 'sec-fetch-site': site }
  req.destroy = () => {}
  // 异步派发 body，贴近真实流式读取。
  queueMicrotask(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

/** 造一个假 ServerResponse，收集状态码与响应体。 */
function makeRes() {
  const chunks = []
  const res = new EventEmitter()
  res.status = null
  res.headers = null
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(String(chunk))
    res.writableEnded = true
  }
  res.off = res.removeListener.bind(res)
  res.__body = () => chunks.join('')
  res.__json = () => JSON.parse(chunks.join(''))
  return res
}

await check('normalizeConfig 钳制越界值并补默认', () => {
  const config = module.normalizeConfig({ targetLanguage: 'klingon', maxTokens: 1e9, concurrency: 99, displayMode: 'weird' }, { batchChars: 99999 })
  // 三处来源的合并优先级：stored 覆盖 declared 覆盖默认。
  assert.equal(config.targetLanguage, 'zh-CN')
  assert.equal(config.maxTokens, 65536)
  assert.equal(config.concurrency, 6)
  assert.equal(config.displayMode, 'dual')
  assert.equal(config.batchChars, 12000)
})

await check('planBatches 同时遵守字符与条数预算', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: 'x'.repeat(100) }))
  const batches = module.planBatches(items, 250, 40)
  assert.ok(batches.length >= 3, `expected several batches, got ${String(batches.length)}`)
  for (const batch of batches) assert.ok(batch.length <= 40)
  assert.equal(batches.flat().length, 5)
})

await check('parseTranslations 兼容围栏 JSON 与 id:译文 两种格式', () => {
  const expected = [{ id: '0' }, { id: '1' }]
  const fenced = module.parseTranslations('```json\n[{"id":"0","text":"甲"},{"id":"1","text":"乙"}]\n```', expected)
  assert.deepEqual([...fenced], [['0', '甲'], ['1', '乙']])
  const lines = module.parseTranslations('0: 甲\n1：乙', expected)
  assert.deepEqual([...lines], [['0', '甲'], ['1', '乙']])
  // 越界 id 被丢弃：模型串了别的批次内容不能污染本批。
  const extra = module.parseTranslations('[{"id":"0","text":"甲"},{"id":"99","text":"越界"}]', expected)
  assert.deepEqual([...extra], [['0', '甲']])
  assert.equal(module.parseTranslations('完全不是 JSON', expected).size, 0)
})

await check('isLoopbackRequest 拒绝非本机与跨站来源', () => {
  assert.equal(module.isLoopbackRequest(makeReq()), true)
  assert.equal(module.isLoopbackRequest(makeReq({ address: '192.168.1.5' })), false)
  assert.equal(module.isLoopbackRequest(makeReq({ host: 'evil.example' })), false)
  assert.equal(module.isLoopbackRequest(makeReq({ site: 'cross-site' })), false)
  assert.equal(module.isLoopbackRequest(makeReq({ origin: 'http://evil.example' })), false)
  assert.equal(module.isLoopbackRequest(makeReq({ origin: null })), true)
})

await check('apply 注册四类路由与两个工具', () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  for (const path of ['/api/dsh-immersive-translate/settings', '/api/dsh-immersive-translate/fetch', '/api/dsh-immersive-translate/translate', '/api/dsh-immersive-translate/text']) {
    assert.ok(ctx.__routes.has(path), `missing route ${path}`)
  }
  assert.deepEqual(ctx.__tools.map((tool) => tool.name).sort(), ['translate_page', 'translate_text'])
  for (const tool of ctx.__tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
  }
})

await check('设置 GET/POST 落盘并可读回', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const route = ctx.__routes.get('/api/dsh-immersive-translate/settings')
  const res1 = makeRes()
  await route.handler(makeReq({ method: 'GET' }), res1)
  assert.equal(res1.status, 200)
  assert.equal(res1.__json().config.targetLanguage, 'zh-CN')
  assert.ok(res1.__json().languages.length >= 9)

  const res2 = makeRes()
  await route.handler(makeReq({ body: { config: { targetLanguage: 'ja', batchChars: 900, userRules: [{ matches: '*.example.com' }] } } }), res2)
  assert.equal(res2.status, 200)

  const file = join(HOME, 'immersive-translate', 'settings.json')
  assert.ok(existsSync(file), 'settings file must be written')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  // 只落用户真正改过的键：默认值不该被固化成"用户设置"。
  assert.deepEqual(Object.keys(stored).sort(), ['batchChars', 'targetLanguage', 'userRules'])
  assert.equal(stored.targetLanguage, 'ja')
})

await check('所有注册都经 ctx.effect 包裹（卸载/热重载不得残留）', () => {
  // 这是硬约束：cordis 只回收 ctx.effect 里的注册。路由若直接 ctx.webServer.register，
  // 卸载时不会摘除，热重载再挂载就会撞上"重复路由"而整块失败——而且旧路由还活着，
  // 表现为"设置能读、但翻译报 cannot get required service llm in inactive context"
  // （2026-09-24 实测踩到）。工具注册同理，故两者一起校验。
  const source = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
  const bare = []
  for (const match of source.matchAll(/ctx\.(?:webServer|tools)\.register\(/g)) {
    // match 本身从 `ctx.` 开始，所以 match 之前的文本应当以 `ctx.effect(() => ` 收尾。
    const before = source.slice(Math.max(0, match.index - 40), match.index)
    if (!/ctx\.effect\(\(\)\s*=>\s*$/.test(before)) {
      bare.push(source.slice(match.index, match.index + 40))
    }
  }
  assert.deepEqual(bare, [], `these registrations are NOT inside ctx.effect: ${bare.join(' | ')}`)
  assert.ok(source.includes('ctx.effect(() => ctx.webServer.register('), 'route registration must be effect-wrapped')
})

await check('账号路由：未登录时明确回报，不谎报已登录', async () => {
  const ctx = makeCtx()
  module.apply(ctx, {})
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/account').handler(makeReq({ method: 'GET' }), res)
  assert.equal(res.status, 200)
  assert.equal(res.__json().ok, true)
  assert.equal(res.__json().loggedIn, false)
})

await check('账号路由：无效令牌被拒绝且不落盘', async () => {
  // 校验必须发生在写入之前：否则用户填错一个字符会被当成"已登录"，
  // 到真正翻译时才报错，很难定位。
  const ctx = makeCtx()
  module.apply(ctx, {})
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/account').handler(makeReq({ body: { token: 'definitely-not-a-real-token' } }), res)
  assert.equal(res.status, 400)
  assert.equal(res.__json().ok, false)
  const file = join(HOME, 'immersive-translate', 'settings.json')
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(!stored.accountToken, '无效令牌不得落盘')
  }
})

await check('账号路由拒绝跨站来源', async () => {
  const ctx = makeCtx()
  module.apply(ctx, {})
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/account').handler(makeReq({ method: 'GET', origin: 'http://evil.example' }), res)
  assert.equal(res.status, 403)
})

await check('免费服务定义齐全且语言码映射正确', () => {
  // 这些端点与语言码取自扩展的 default_config.json；写死在这里是为了在它们被
  // 上游改动时测试能失败，而不是等到用户翻译时才静默出错。
  assert.deepEqual(Object.keys(module.FREE_SERVICES).sort(), ['bing', 'google', 'transmart', 'zhipu-free'])
  // 未实现的服务必须显式标注：否则自检与回退链会报含混的"不支持的免费服务"。
  assert.equal(module.FREE_SERVICES.bing.implemented, false)
  assert.equal(module.FREE_SERVICES.transmart.implemented, true)
  assert.equal(module.FREE_SERVICES.google.implemented, true)
  assert.equal(module.targetCodeFor('transmart', 'zh-CN'), 'zh')
  assert.equal(module.targetCodeFor('bing', 'zh-CN'), 'zh-Hans')
  assert.equal(module.targetCodeFor('google', 'zh-TW'), 'zh-TW')
  assert.equal(module.targetCodeFor('zhipu-free', 'zh-CN'), 'Chinese')
})

await check('默认引擎是自带免费服务，不占用用户模型', () => {
  // 这是本次移植的核心诉求：默认绝不能去花用户自己的模型额度。
  const config = module.normalizeConfig({}, {})
  assert.equal(config.engine, 'auto')
  assert.equal(config.useDshModel, false)
  assert.equal(config.allowModelFallback, false)
})

await check('免费服务：transmart 请求体符合扩展协议', async () => {
  const ctx = makeCtx()
  module.apply(ctx, {})
  const calls = []
  // 用假 fetch 拦截，避免测试依赖外网。
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ header: { ret_code: 'succ' }, auto_translation: items.map((item) => `译:${item.text}`) }) }
  }
  const items = [{ id: 'a', text: 'Hello' }]
  const map = await module.callFreeService({ serviceId: 'transmart', items, targetLanguage: 'zh-CN', fetchImpl: fakeFetch })
  assert.equal(map.get('a'), '译:Hello')
  assert.equal(calls[0].url, 'https://transmart.qq.com/api/imt')
  assert.equal(calls[0].body.header.fn, 'auto_translation')
  assert.equal(calls[0].body.target.lang, 'zh')
  assert.deepEqual(calls[0].body.source.text_list, ['Hello'])
})

await check('免费服务：某个服务失败时按顺序回退到下一个', async () => {
  const ctx = makeCtx()
  module.apply(ctx, {})
  const tried = []
  const fakeFetch = async (url) => {
    tried.push(url)
    if (url.includes('transmart')) return { ok: false, status: 500, json: async () => ({}) }
    if (url.includes('aigw1')) return { ok: false, status: 403, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ([[['译:ok']]]) }
  }
  const map = await module.callFreeService({ serviceId: 'google', items: [{ id: 'a', text: 'x' }], targetLanguage: 'zh-CN', fetchImpl: fakeFetch })
  assert.equal(map.get('a'), '译:ok')
})

await check('services 路由回报每个免费服务的可用性', async () => {
  const ctx = makeCtx()
  module.apply(ctx, {})
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/services').handler(makeReq({ method: 'GET' }), res)
  assert.equal(res.status, 200)
  const json = res.__json()
  assert.equal(json.ok, true)
  // 至少要把定义过的服务都探一遍，让用户知道"哪个不通"。
  assert.ok(Array.isArray(json.services))
  assert.ok(json.services.length >= 3)
  for (const item of json.services) assert.ok(typeof item.id === 'string' && typeof item.ok === 'boolean')
})

await check('设置里点名某个服务时锁定它，不被回退链换别家', async () => {
  // 设置面板可选 google / transmart / zhipu-free。若分发时忽略它、一律走回退链，
  // 用户"选了 google"其实还是 transmart 先接走，选择形同虚设。
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'google' })
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return { ok: false, status: 500, json: async () => ({}) }
  }
  try {
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/batch').handler(makeReq({ body: { items: [{ id: 'a', text: 'Hello' }] } }), res)
  } finally {
    globalThis.fetch = original
  }
  // 只应打 google 的域名；不得出现 transmart（那说明被回退链换掉了）。
  assert.ok(seen.length > 0, '应当发起过请求')
  for (const url of seen) assert.ok(url.includes('translate.googleapis.com'), `不该请求 ${url}`)
  assert.ok(!seen.some((url) => url.includes('transmart')), '锁定 google 时不得转去 transmart')
})

await check('设置保存不会清掉已登录的账号令牌', async () => {
  // 令牌与设置同存一个文件：若保存设置时直接覆盖，用户一改配置就会被登出。
  const ctx = makeCtx()
  module.apply(ctx, {})
  const file = join(HOME, 'immersive-translate', 'settings.json')
  // 先手工写入一个令牌，模拟"已登录"。
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ accountToken: 'kept-token', targetLanguage: 'ja' }))
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/settings').handler(makeReq({ body: { config: { batchChars: 800 } } }), res)
  assert.equal(res.status, 200)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.accountToken, 'kept-token', '保存设置不得清掉账号令牌')
  assert.equal(stored.batchChars, 800)
})

await check('设置路由拒绝跨站写入', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/settings').handler(makeReq({ method: 'GET', origin: 'http://evil.example' }), res)
  assert.equal(res.status, 403)
})

await check('text 路由把文本翻译回传', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello world' } }), res)
  assert.equal(res.status, 200)
  assert.equal(res.__json().text, '译:Hello world')
  assert.equal(ctx.__calls.length, 1)
})

await check('batch 路由按 id 对齐返回译文（就地注入路径）', async () => {
  // 这条路由是"就地注入"的关键：客户端把扫到的文本节点批量送来，按 id 拿回译文。
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/batch').handler(
    makeReq({ body: { items: [{ id: 'b1', text: 'Hello world' }, { id: 'e1', text: 'click here' }] } }),
    res,
  )
  assert.equal(res.status, 200)
  const json = res.__json()
  assert.equal(json.ok, true)
  assert.equal(json.total, 2)
  assert.equal(json.failed, 0)
  // 按 id 对齐：客户端就是靠这个 id 把译文写回对应 DOM 节点。
  assert.equal(json.translations.b1, '译:Hello world')
  assert.equal(json.translations.e1, '译:click here')
})

await check('batch 路由丢弃空白项、空数组报 400', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const route = ctx.__routes.get('/api/dsh-immersive-translate/batch')

  const res1 = makeRes()
  await route.handler(makeReq({ body: { items: [{ id: 'a', text: '   ' }, { id: '', text: 'x' }, null, { id: 'b', text: 'Hello world' }] } }), res1)
  assert.equal(res1.status, 200)
  assert.equal(res1.__json().total, 1, '空白项与无 id 项必须被丢弃')

  const res2 = makeRes()
  await route.handler(makeReq({ body: { items: [] } }), res2)
  assert.equal(res2.status, 400)
})

await check('batch 路由在模型漏译时回填原文而不是留空洞', async () => {
  // 模型偶尔会漏掉条目。客户端拿不到译文时若留空，页面上会凭空少一段文字——
  // 宁可回填原文，也不要破坏页面内容。
  const ctx = makeCtx({ translation: () => 'not-json-at-all' })
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/batch').handler(
    makeReq({ body: { items: [{ id: 'b1', text: 'Hello world' }] } }),
    res,
  )
  assert.equal(res.status, 200)
  const json = res.__json()
  assert.equal(json.translations.b1, 'Hello world', '漏译必须回填原文')
  assert.equal(json.failed, 1, '失败计数要如实反映')
})

await check('batch 路由拒绝跨站来源', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/batch').handler(makeReq({ origin: 'http://evil.example' }), res)
  assert.equal(res.status, 403)
})

await check('text 路由空文本报 400 且不调用模型', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: '   ' } }), res)
  assert.equal(res.status, 400)
  assert.equal(ctx.__calls.length, 0)
})

await check('翻译调用带上目标语言与系统提示词', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello', targetLanguage: 'en' } }), makeRes())
  const call = ctx.__calls[0]
  assert.match(call.system, /翻译/)
  assert.match(call.messages[0].content[0].text, /English/)
  assert.equal(call.temperature, 0.2)
})

await check('推理强度被拒时自动按默认档位重试一次', async () => {
  const ctx = makeCtx({ failTimes: 1 })
  module.apply(ctx, { engine: 'dsh-model', reasoningEffort: 'max' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello' } }), res)
  assert.equal(res.status, 200, `expected retry to succeed, body=${res.__body().slice(0, 200)}`)
  assert.equal(ctx.__calls.length, 2)
  assert.equal(ctx.__calls[0].reasoningEffort, 'max')
  assert.equal(ctx.__calls[1].reasoningEffort, undefined)
})

await check('没有模型路由时给出可操作报错', async () => {
  const ctx = makeCtx({ selection: null })
  module.apply(ctx, { engine: 'dsh-model' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello' } }), res)
  // selection 为 null → resolveRoute 直接抛错并给出可操作提示。
  assert.equal(res.status, 400)
  assert.match(res.__json().error, /没有可用的模型路由/)
})

await check('显式 provider/model 可绕开默认模型', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model', provider: 'deepseek', model: 'deepseek-chat' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello' } }), res)
  assert.equal(res.status, 200)
  assert.equal(ctx.__calls[0].provider, 'deepseek')
  assert.equal(ctx.__calls[0].model, 'deepseek-chat')
})

await check('只填 provider 不填 model 明确报错', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model', provider: 'deepseek' })
  const res = makeRes()
  await ctx.__routes.get('/api/dsh-immersive-translate/text').handler(makeReq({ body: { text: 'Hello' } }), res)
  assert.equal(res.status, 400)
  assert.match(res.__json().error, /必须同时配置/)
})

await check('fetch 路由抽取正文并遵守 maxBlocks', async () => {
  const ctx = makeCtx()
  // 用 localhost 上的极简 HTTP 服务当抓取目标，避免依赖外网。
  const { createServer } = await import('node:http')
  const html = `<html><head><title>Fixture</title></head><body>${Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${String(i)} of the fixture page.</p>`).join('')}</body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    // maxBlocks 的下界是 20（设置页与 normalizeConfig 同口径），这里用 25 验证截断。
    module.apply(ctx, { engine: 'dsh-model', maxBlocks: 25, fetchMode: 'native' })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/fetch').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    assert.equal(res.status, 200, res.__body().slice(0, 300))
    const payload = res.__json()
    assert.equal(payload.title, 'Fixture')
    assert.equal(payload.total, 25)
    assert.equal(payload.blocks[0].text, 'Paragraph 0 of the fixture page.')
    assert.equal(payload.via, 'native')

    // 非 http(s) 地址必须被挡。
    const bad = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/fetch').handler(makeReq({ body: { url: 'file:///etc/passwd' } }), bad)
    assert.equal(bad.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('translate 路由流式返回双语事件', async () => {
  const ctx = makeCtx()
  const { createServer } = await import('node:http')
  const html = `<html><head><title>Stream</title></head><body>
    <h1>Title here</h1>
    <p>First paragraph text.</p>
    <pre><code>const a = 1</code></pre>
    <p>12</p>
  </body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native' })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/translate').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    assert.equal(res.status, 200)
    const events = res.__body().trim().split('\n').map((line) => JSON.parse(line))
    const meta = events.find((event) => event.type === 'meta')
    const done = events.find((event) => event.type === 'done')
    const blocks = events.filter((event) => event.type === 'block')
    assert.equal(meta.title, 'Stream')
    assert.equal(meta.total, 4)
    assert.equal(done.translated, 2, 'h1 + the readable paragraph are translatable; the code block and the bare number are not')
    // 代码块与纯数字块以 skipped 事件回填，不进模型。
    const skipped = events.filter((event) => event.type === 'block' && event.skipped === true)
    assert.equal(skipped.length, 2, 'pre/code and the bare "12" paragraph are回填 without calling the model')
    assert.deepEqual(skipped.map((event) => event.source), ['const a = 1', '12'])
    const titles = blocks.map((block) => block.translation)
    assert.ok(titles.includes('译:Title here'))
    assert.ok(titles.includes('译:First paragraph text.'))
    assert.equal(ctx.__calls.length, 1, 'a short page should be one batch')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('translate 路由按批切分并逐个返回译文', async () => {
  const ctx = makeCtx()
  const { createServer } = await import('node:http')
  const html = `<html><body>${Array.from({ length: 12 }, (_, i) => `<p>${'Sentence content '.repeat(20)}number ${String(i)}</p>`).join('')}</body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native', batchChars: 1200, concurrency: 2 })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/translate').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    const events = res.__body().trim().split('\n').map((line) => JSON.parse(line))
    const done = events.find((event) => event.type === 'done')
    assert.ok(ctx.__calls.length >= 2, `expected multiple batches, got ${String(ctx.__calls.length)}`)
    assert.ok(done.translated >= 12, `expected all paragraphs translated, got ${String(done.translated)}`)
    assert.equal(done.failed, 0)
    for (const call of ctx.__calls) {
      const items = JSON.parse(call.messages[0].content[0].text.slice(call.messages[0].content[0].text.indexOf('[')))
      const chars = items.reduce((sum, item) => sum + item.text.length, 0)
      assert.ok(chars <= 2000, `batch too large: ${String(chars)}`)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('某个批次模型跑偏时报错但不中断整页', async () => {
  let count = 0
  const ctx = makeCtx({
    translation: (items) => {
      count += 1
      if (count === 1) return '对不起，我不能这样。'
      return JSON.stringify(items.map((item) => ({ id: item.id, text: `译:${item.text}` })))
    },
  })
  const { createServer } = await import('node:http')
  const html = `<html><body>${Array.from({ length: 8 }, (_, i) => `<p>${'Long sentence content '.repeat(30)}${String(i)}</p>`).join('')}</body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native', batchChars: 900, concurrency: 1 })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/translate').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    const events = res.__body().trim().split('\n').map((line) => JSON.parse(line))
    const done = events.find((event) => event.type === 'done')
    const errors = events.filter((event) => event.type === 'batch-error')
    assert.ok(errors.length >= 1, 'a malformed reply must be reported')
    assert.ok(done.translated > 0, 'the remaining batches must still translate')
    assert.ok(done.failed > 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('translate_text 工具直接可用', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const tool = ctx.__tools.find((item) => item.name === 'translate_text')
  const output = await tool.execute({ text: 'Hello tool' }, { signal: new AbortController().signal })
  assert.match(output, /译:Hello tool/)
  assert.match(output, /目标语言/)
})

await check('translate_page 工具输出原文 + 译文对照', async () => {
  const ctx = makeCtx()
  const { createServer } = await import('node:http')
  const html = '<html><head><title>Doc</title></head><body><h1>Getting started</h1><p>Read this first.</p></body></html>'
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native' })
    const tool = ctx.__tools.find((item) => item.name === 'translate_page')
    const output = await tool.execute({ url: `http://127.0.0.1:${String(port)}/` }, { signal: new AbortController().signal })
    assert.match(output, /Getting started/)
    assert.match(output, /译:Getting started/)
    assert.match(output, /Read this first\./)
    assert.match(output, /译:Read this first\./)
    assert.match(output, /统计/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('describeFetchError 把底层 cause 展开成可行动说明', () => {
  // undici 的 "fetch failed" 单独看毫无信息，必须把嵌套 cause 一起暴露。
  const dns = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND en.wikipedia.org'), { code: 'ENOTFOUND' }) })
  const dnsMsg = module.describeFetchError(dns, 'https://en.wikipedia.org/x')
  assert.match(dnsMsg, /fetch failed/)
  assert.match(dnsMsg, /ENOTFOUND/)
  assert.match(dnsMsg, /域名解析失败/)
  assert.match(dnsMsg, /en\.wikipedia\.org/)

  const conn = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  assert.match(module.describeFetchError(conn, 'https://x.test/'), /连接失败/)

  const plain = module.describeFetchError(new Error('boom'), 'https://x.test/')
  assert.match(plain, /boom/)
  assert.ok(!/undefined/.test(plain), `must not stringify undefined: ${plain}`)

  // 自引用 cause 不能造成死循环。
  const loop = new Error('self')
  loop.cause = loop
  assert.match(module.describeFetchError(loop, 'https://x.test/'), /self/)
})

await check('抓取不可达站点时返回可读的 502', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native', timeoutMs: 8000 })
  const res = makeRes()
  // .invalid 是 RFC 2606 保留域名，保证解析失败。
  await ctx.__routes.get('/api/dsh-immersive-translate/fetch').handler(
    makeReq({ body: { url: 'https://definitely-not-a-real-host.invalid/' } }), res)
  assert.equal(res.status, 502)
  const err = res.__json().error
  assert.match(err, /抓取失败/)
  assert.ok(err.length > 30, `error should be descriptive, got: ${err}`)
  assert.ok(!/^抓取失败：fetch failed$/.test(err), 'opaque fetch failed must be expanded')
})

await check('translate_page 工具拒绝非 http(s) 地址', async () => {
  const ctx = makeCtx()
  module.apply(ctx, { engine: 'dsh-model' })
  const tool = ctx.__tools.find((item) => item.name === 'translate_page')
  await assert.rejects(() => tool.execute({ url: 'ftp://example.com/x' }, { signal: new AbortController().signal }), /http\/https/)
})

await check('默认并发为 1（不与 Agent 抢同一条模型路由）', () => {
  // 翻译与交互共用 ctx.llm；默认并发 3 会在大页翻译时把用户对话挤到后面。
  assert.equal(module.normalizeConfig().concurrency, 1)
  assert.equal(module.normalizeConfig({ concurrency: 3 }).concurrency, 3, 'user may still opt in')
  assert.equal(module.normalizeConfig({ concurrency: 99 }).concurrency, 6, 'clamped to the ceiling')
  assert.equal(module.normalizeConfig({ concurrency: 0 }).concurrency, 1, 'clamped to the floor')
})

await check('autoTranslate / showBall 必须是"已登记"的配置键（否则落盘被白名单丢弃）', () => {
  // 真 bug：落盘走 writeSettingsPatch，会按 `key in DEFAULTS` 过滤。
  // 「打开页面自动翻译」这个键原先没登记，保存时被静默丢弃 → 刷新即失效，
  // 用户看到的就是"这个功能不生效"。这里把登记关系钉住。
  const config = module.normalizeConfig({}, {})
  assert.equal(typeof config.autoTranslate, 'boolean', 'autoTranslate 必须被 normalizeConfig 产出')
  assert.equal(typeof config.showBall, 'boolean', 'showBall 必须被 normalizeConfig 产出')
  assert.equal(module.normalizeConfig({ autoTranslate: true }, {}).autoTranslate, true, 'autoTranslate=true 必须被保留')
  assert.equal(module.normalizeConfig({ showBall: false }, {}).showBall, false, 'showBall=false 必须被保留')
})

await check('免费服务并发默认 4，并在 1..8 之间钳制', () => {
  // 实测：并发 2 → 8 批 7679ms；并发 6 → 3311ms。默认取 4，上限 8。
  const d = module.normalizeConfig({}, {})
  assert.equal(d.freeConcurrency, 4)
  assert.equal(module.normalizeConfig({ freeConcurrency: 1 }, {}).freeConcurrency, 1)
  assert.equal(module.normalizeConfig({ freeConcurrency: 99 }, {}).freeConcurrency, 8, '钳到上限')
  assert.equal(module.normalizeConfig({ freeConcurrency: 0 }, {}).freeConcurrency, 1, '钳到下限')
})

await check('busy / 限流 / 网络抖动被判定为可重试，鉴权失败不重试', () => {
  // 实测并发 4 时 transmart 会偶发放 `Server is busy now, (10000)`。
  // 旧实现遇到即整批失败且不再重试 → 那部分内容永远不翻译（用户看到的"遗漏"）。
  assert.equal(module.isRetryableServiceFailure(new Error('transmart 失败：Server is busy now, (10000), please retry later')), true)
  assert.equal(module.isRetryableServiceFailure(new Error('transmart HTTP 503')), true)
  assert.equal(module.isRetryableServiceFailure(new Error('fetch failed')), true)
  assert.equal(module.isRetryableServiceFailure(new Error('transmart 失败：Too many characters (over 6000) in block')), true)
  assert.equal(module.isRetryableServiceFailure(new Error('令牌无效或已过期，请重新登录')), false, '鉴权失败重试没意义')
  assert.equal(module.isRetryableServiceFailure(new Error('该服务尚未实现：bing')), false)
})

await check('整页翻译时长预算随批次数伸缩且有明确上下界', () => {
  const small = module.streamingBudgetForBatches({ concurrency: 1 }, 2)
  const big = module.streamingBudgetForBatches({ concurrency: 1 }, 48)
  assert.ok(small >= 60_000, 'never below 60s')
  assert.ok(big > small, 'more batches must allow more time')
  assert.ok(big <= 600_000, 'never above 10min')
  // 并发摊薄：同样的批数，并发高则预算低。
  assert.ok(module.streamingBudgetForBatches({ concurrency: 3 }, 48) < module.streamingBudgetForBatches({ concurrency: 1 }, 48))
  // 畸形输入不产生 NaN / 负数。
  for (const value of [module.streamingBudgetForBatches({}, 0), module.streamingBudgetForBatches({}, -5), module.streamingBudgetForBatches({ concurrency: 0 }, 1)]) {
    assert.ok(Number.isFinite(value) && value >= 60_000, `bad budget: ${String(value)}`)
  }
  // 起步值按最坏批数估算，必然不小于按真实小批数收紧后的结果。
  assert.ok(module.streamingBudgetMs({ maxBlocks: 500 }) >= module.streamingBudgetForBatches({ concurrency: 1 }, 3))
})

await check('meta 事件带真实批次数', async () => {
  const ctx = makeCtx()
  const { createServer } = await import('node:http')
  const html = `<html><body>${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${String(i)} with enough words to be translated.</p>`).join('')}</body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    module.apply(ctx, { engine: 'dsh-model', fetchMode: 'native', batchChars: 3500 })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/translate').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    const meta = res.__body().trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'meta')
    assert.equal(typeof meta.batches, 'number')
    assert.ok(meta.batches >= 1, `expected at least one batch, got ${String(meta.batches)}`)
    assert.equal(meta.translatable, 6)
    assert.equal(meta.total, 6)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('用户规则命中时在 meta 事件里报出', async () => {
  const ctx = makeCtx()
  const { createServer } = await import('node:http')
  const html = '<html><body><p>Rule matched page content.</p></body></html>'
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    // 设置文件在同一个 DSH_HOME 下是跨 apply 持久的（用户显式设置优先于声明配置），
    // 所以这里先清掉前面用例写下的那份，才能验证声明的 userRules 生效。
    rmSync(join(HOME, 'immersive-translate', 'settings.json'), { force: true })
    module.apply(ctx, { fetchMode: 'native', userRules: [{ id: 'local', matches: '127.0.0.1', selectors: ['.x'] }] })
    const res = makeRes()
    await ctx.__routes.get('/api/dsh-immersive-translate/translate').handler(makeReq({ body: { url: `http://127.0.0.1:${String(port)}/` } }), res)
    const meta = res.__body().trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'meta')
    assert.equal(meta.rule.ruleId, 'local')
    assert.deepEqual(meta.rule.selectors, ['.x'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// 清理临时 DSH_HOME。
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${String(passed)} host checks passed`)

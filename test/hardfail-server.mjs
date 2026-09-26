/**
 * 复现用「假宿主」：只实现客户端引擎真正会打的两条路由。
 *
 * 关键注入点：/batch 只对**含 FAILMARK 条目的那一批**返回 HTTP 500，
 * 其余批次照常返回译文 —— 用来把「硬失败（非 200）」这条路径单独拎出来。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

// 默认取本仓库自己的客户端 —— 曾硬编码 /tmp 下的一份副本，
// 导致对 lib/client.js 的修复从未被本测试执行过（2026-09-25 踩到）。
const CLIENT_PATH = process.env.IMT_CLIENT ?? new URL('../lib/client.js', import.meta.url).pathname

/** 24 段正常段落：占满客户端第一个 chunk（CHUNK_ITEMS = 24）。 */
const OK_COUNT = 24
/** 4 段注入失败段落：落在第二个 chunk，整批一起失败。 */
const FAIL_COUNT = 4

function fixtureHtml() {
  const ok = []
  for (let i = 0; i < OK_COUNT; i += 1) {
    ok.push(`<p id="ok${String(i)}">Hello world number ${String(i)} must be translated.</p>`)
  }
  const fail = []
  for (let i = 0; i < FAIL_COUNT; i += 1) {
    fail.push(`<p id="fail${String(i)}">FAILMARK paragraph number ${String(i)} must be translated.</p>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>imt repro</title></head><body>
<h1>复现夹具</h1>
<div id="okzone">${ok.join('\n')}</div>
<div id="failzone">${fail.join('\n')}</div>
<script>window.__ModuleLoader__ = { load(entry) { window.__entry = entry } };</script>
<script src="/client.js"></script>
<script src="/boot.js"></script>
</body></html>`
}

/**
 * 最小 loader + React 桩：把 client.js 工厂跑起来并 apply。
 *
 * 另外把 >=3s 的定时器放大 4 倍 —— 只影响「汇报战果」这条 UI 定时器
 * （3500ms），让它在引擎**跑完之后**才读取统计，而不是读到跑批过程中的中间值。
 * 引擎自身的重试退避（400/800/1600ms）与去抖（700ms）不受影响。
 */
const BOOT_JS = `
(function () {
  // 截获「汇报战果」这个 3500ms 定时器（lib/client.js 里唯一一处 3500ms）：
  // 引擎处于「永久失败批次 → 反复重扫」的循环里，统计值在 0 与 N 之间来回跳，
  // 固定等 3.5s 读到的是随机相位。这里把它攥在手里，由测试在
  // 「悬浮球处于 done（即 failed 已被抹成 0）」的时刻手动触发，读数才有确定性。
  window.__imtReport = null;
  const rawSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, delay, ...rest) => {
    if (typeof delay === 'number' && delay === 3500) { window.__imtReport = fn; return 0; }
    return rawSetTimeout(fn, delay, ...rest);
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: (v) => ({ current: v }),
    useEffect: () => undefined,
  };
  const mod = window.__entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
  const ctx = {
    effect(factory) { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
    slots: { inject: () => () => {}, register: () => () => {} },
    get: () => undefined,
  };
  mod.apply(ctx);
  window.__imt = mod;
  // 记录悬浮球 data-state 的跃迁（用于证明「先红后绿」：引擎知道失败，随后又把计数抹掉）。
  window.__ballTimeline = [];
  const ball = document.querySelector('.imt-ball-wrap');
  if (ball !== null) {
    new MutationObserver(() => {
      const state = ball.getAttribute('data-state');
      const last = window.__ballTimeline[window.__ballTimeline.length - 1];
      if (last === undefined || last.state !== state) window.__ballTimeline.push({ t: Date.now(), state });
    }).observe(ball, { attributes: true, attributeFilter: ['data-state'] });
  }
})();
`

/**
 * 起假宿主。
 * @param {{ port?: number, onLog?: (entry: object) => void, quiet?: boolean }} [options] - 选项。
 * @returns {Promise<{ port: number, close: () => Promise<void>, log: object[] }>} 句柄。
 */
export async function startServer(options = {}) {
  const log = []
  let batchSeq = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fixtureHtml())
      return
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(readFileSync(CLIENT_PATH, 'utf8'))
      return
    }
    if (url.pathname === '/boot.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(BOOT_JS)
      return
    }
    if (url.pathname === '/api/dsh-immersive-translate/settings') {
      json(200, {
        ok: true,
        hostProtocol: 3,
        config: {
          targetLanguage: 'zh-CN',
          displayMode: 'translation',
          autoTranslate: true,
          showBall: true,
          freeConcurrency: 4,
          batchChars: 3500,
          concurrency: 1,
          userRules: [],
        },
        languages: [{ id: 'zh-CN', label: '中文（简体）' }],
      })
      return
    }
    if (url.pathname === '/api/dsh-immersive-translate/batch') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const items = Array.isArray(body.items) ? body.items : []
        const hasFail = items.some((item) => String(item.text).includes('FAILMARK'))
        batchSeq += 1
        const entry = { seq: batchSeq, t: Date.now(), items: items.length, chunk: hasFail ? 'fail' : 'ok', ids: items.map((item) => item.id) }
        log.push(entry)
        options.onLog?.(entry)
        if (!options.quiet) console.log(`[stub] #${String(entry.seq)} ${entry.chunk}-chunk items=${String(entry.items)} ${entry.t}`)
        if (hasFail) {
          json(500, { ok: false, error: 'injected 500 for FAILMARK chunk' })
          return
        }
        const translations = {}
        for (const item of items) translations[item.id] = `【译】${String(item.text).slice(0, 80)}`
        json(200, { ok: true, translations, missing: [], failed: 0, total: items.length, language: 'zh-CN' })
      })
      return
    }
    if (url.pathname === '/api/dsh-immersive-translate/text') {
      json(200, { ok: true, text: '【译】划词', usage: null })
      return
    }
    if (url.pathname === '/__log') {
      json(200, { ok: true, log })
      return
    }
    if (url.pathname === '/__reset') {
      log.length = 0
      batchSeq = 0
      json(200, { ok: true })
      return
    }
    json(404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

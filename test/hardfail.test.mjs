/**
 * 回归测试：批次「硬失败」（重试耗尽）必须被如实登记，且引擎必须收敛。
 *
 * 背景（2026-09-25 实测复现）：lib/client.js 的硬失败分支只做
 * `stats.failed += chunk.length` 就 continue，**没有**像"漏译 missing"路径那样
 * 登记进 stats.unresolved；同一轮收尾又执行 `stats.failed = stats.unresolved.size`，
 * 把刚记下的失败抹成 0。放大器是 paint() 用等值赋值写 .imt-ball-badge 的
 * textContent（赋值即替换文本节点 → childList 变更），而悬浮球挂在 body 上、
 * 正在引擎自己的 MutationObserver 范围内 → emitState → paint → schedule →
 * 再跑一轮 → 再抹零，**不收敛也不停**。
 *
 * 修复后本测试断言（与缺陷期断言正好相反）：
 *  1. 失败批的块保持原文、不打 data-imt-done（这条缺陷期也成立，保留）；
 *  2. 悬浮球**不再**稳态显示成功 —— failed 必须如实反映；
 *  3. 汇报文案**必须提失败**；
 *  4. 重扫**必须收敛**（第二观察窗口不再持续新增 /batch）；
 *  5. 不再出现「先红（引擎知道失败）→ 后绿（被抹成 0）」的跃迁。
 *
 * 运行：
 *   node test/hardfail.test.mjs            自动断言（真 Chromium + 假宿主）
 *   node test/hardfail.test.mjs --serve    只起假宿主，供人工验证
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startServer } from './hardfail-server.mjs'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 找本机实际存在的 Chromium（与仓库 test/inject-browser.mjs 同款发现逻辑）。 */
function findExecutable() {
  const cache = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
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

/** 页面内状态快照。 */
const readState = () => {
  const countDone = (selector) => [...document.querySelectorAll(selector)].filter((node) => node.getAttribute('data-imt-done') !== null).length
  const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '')
  return {
    okDone: countDone('#okzone p'),
    okTotal: document.querySelectorAll('#okzone p').length,
    failDone: countDone('#failzone p'),
    failTotal: document.querySelectorAll('#failzone p').length,
    failTexts: texts('#failzone p'),
    ballState: document.querySelector('.imt-ball-wrap')?.getAttribute('data-state') ?? null,
    toastText: document.querySelector('.imt-toast')?.textContent?.trim() ?? '',
  }
}

/** 轮次：失败批次每轮扫描都会拿到一批新 id（b29.. / b34.. ），按首 id 归并。 */
const failRounds = (log) => new Set(log.filter((entry) => entry.chunk === 'fail').map((entry) => entry.ids[0])).size

async function main() {
  const server = await startServer({ quiet: true })
  const origin = `http://127.0.0.1:${String(server.port)}/`
  const playwrightPath = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'profiles', 'desktop', 'node_modules', 'playwright')
  const { chromium } = require(playwrightPath)
  const browser = await chromium.launch({ executablePath: findExecutable() })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (m) => { const tx = m.text(); if (tx.includes('[diag]') || tx.includes('[mut]')) console.log('     ' + tx) })

  try {
    await page.goto(origin)

    // ── 阶段 A：自动翻译跑起来，失败批次硬挂 ────────────────────────────────
    let ready = null
    for (let i = 0; i < 60; i += 1) {
      const state = await page.evaluate(readState)
      if (state.okDone === state.okTotal && state.okTotal > 0) { ready = state; break }
      await sleep(250)
    }
    assert.ok(ready !== null, `正常段落未被翻译（引擎没跑起来？pageerror=${pageErrors.join(';')}）`)
    await sleep(8000) // 让循环多跑几轮

    const snapshot = await page.evaluate(readState)
    const postsInFirstWindow = server.log.length
    await sleep(6000)
    const postsInSecondWindow = server.log.length

    // 悬浮球状态分布：每 50ms 采一次，持续 6 秒。
    const samples = []
    for (let i = 0; i < 120; i += 1) {
      samples.push(await page.evaluate(() => document.querySelector('.imt-ball-wrap')?.getAttribute('data-state') ?? null))
      await sleep(50)
    }
    const doneShare = samples.filter((value) => value === 'done').length / samples.length
    const ballTimeline = await page.evaluate(() => window.__ballTimeline ?? [])
    const errorToDone = ballTimeline.filter((entry, index) => index > 0 && ballTimeline[index - 1].state === 'error' && entry.state === 'done').length

    // ── 汇报文案：等失败发生、汇报定时器就位后手动触发它（缺陷期这里等的是 done）──
    const failsBeforeToggle = server.log.filter((entry) => entry.chunk === 'fail').length
    // 开关拨两次 = 还原 → 重新开启（插件已收敛成"一个开关"）。
    if (!(await page.isVisible('.imt-menu'))) await page.click('.imt-ball')
    await page.click('.imt-switch-row')
    await sleep(800)
    if (!(await page.isVisible('.imt-menu'))) await page.click('.imt-ball')
    await page.click('.imt-switch-row')
    let fired = null
    for (let i = 0; i < 600; i += 1) {
      const failAttempts = server.log.filter((entry) => entry.chunk === 'fail').length - failsBeforeToggle
      const state = await page.evaluate(readState)
      const hasReport = await page.evaluate(() => typeof window.__imtReport === 'function')
      if (failAttempts >= 4 && hasReport) {
        fired = await page.evaluate(() => {
          const fn = window.__imtReport
          window.__imtReport = null
          if (typeof fn === 'function') { fn(); return true }
          return false
        })
        if (fired === true) break
      }
      await sleep(100)
    }
    assert.equal(fired, true, '没等到可触发的汇报定时器')
    const reported = await page.evaluate(readState)
    const failsAfterReport = server.log.filter((entry) => entry.chunk === 'fail').length

    // ── 阶段 B：摘掉悬浮球（消除引擎自身 UI 变更），看循环是否立刻停 ──────────
    const beforeRemove = server.log.length
    await page.evaluate(() => { document.querySelector('.imt-ball-wrap')?.remove() })
    await sleep(6000)
    const afterFirstWindow = server.log.length
    await sleep(6000)
    const afterSecondWindow = server.log.length
    const finalState = await page.evaluate(readState)

    const report = {
      okTranslated: `${String(snapshot.okDone)}/${String(snapshot.okTotal)}`,
      failTranslated: `${String(snapshot.failDone)}/${String(snapshot.failTotal)}`,
      failTextsStillOriginal: snapshot.failTexts.every((text) => text.startsWith('FAILMARK')),
      roundsIn14s: failRounds(server.log),
      requests: `+${String(postsInSecondWindow - postsInFirstWindow)} / 6s（持续中）`,
      ballDoneShare: `${String(Math.round(doneShare * 100))}%`,
      ballErrorToDoneTransitions: errorToDone,
      reportedToast: reported.toastText,
      failAttemptsAfterReport: failsAfterReport,
      loopAfterBallRemoved: `摘球后 0-6s 新增 ${String(afterFirstWindow - beforeRemove)} 次；6-12s 新增 ${String(afterSecondWindow - afterFirstWindow)} 次`,
      finalFailTexts: finalState.failTexts,
      finalFailDone: finalState.failDone,
      pageErrors,
    }
    const schedTrace = await page.evaluate(() => (window.__imtSched || []).slice(-14))
    console.log('\n=== schedule() 调用栈（最后 14 次）===')
    for (const t of schedTrace) console.log('   ' + String(t).split(' <- ').slice(0,3).join(' ← '))
    const tr = await page.evaluate(() => (window.__imtSched || []).slice(-10))
    console.log('\n=== schedule() 调用栈（最后 10 次）===')
    for (const x of tr) console.log('     ' + String(x).split(' <- ').slice(0,3).join(' ← '))
    console.log('\n=== 复现结果 ===')
    console.log(JSON.stringify(report, null, 2))

    // ── 修复后的应然行为（与缺陷期断言相反）──
    const rescanGrowth = postsInSecondWindow - postsInFirstWindow
    const fixedOk = snapshot.failDone === 0
      && report.failTextsStillOriginal
      && doneShare <= 0.2
      && errorToDone <= 8
      && /失败/.test(reported.toastText)
      && rescanGrowth <= 2
      && finalState.failDone === 0
    console.log('\n判定:', fixedOk ? '修复生效（失败被如实登记、球报错、重扫收敛）' : '修复未生效')
    if (!fixedOk) {
      console.log('  诊断: failDone=' + String(snapshot.failDone)
        + ' doneShare=' + String(Math.round(doneShare * 100)) + '%'
        + ' errorToDone=' + String(errorToDone)
        + ' rescanGrowth=' + String(rescanGrowth)
        + ' toast="' + String(reported.toastText) + '"')
    }

    assert.equal(snapshot.failDone, 0, '失败批次的块必须保持原文（不打 done）')
    assert.ok(report.failTextsStillOriginal, '失败批次的原文必须未被改动')
    assert.ok(doneShare <= 0.2, `悬浮球不应稳态显示成功（done 占比 ${String(Math.round(doneShare * 100))}%）`)
    assert.ok(errorToDone <= 8, `状态翻转次数应有界（实际 ${String(errorToDone)}）`)
    assert.ok(/失败/.test(reported.toastText), `汇报文案必须如实提失败，实际="${reported.toastText}"`)
    assert.ok(rescanGrowth <= 2, `重扫必须收敛（第二窗口新增 ${String(rescanGrowth)} 次 /batch）`)
    assert.equal(fixedOk, true)
    console.log('\n全部断言通过。')
    // 断言全过即视为修复生效；任何一条失败会抛 AssertionError 并以非 0 退出。
    process.exitCode = 0
  } finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

if (process.argv.includes('--serve')) {
  const index = process.argv.indexOf('--port')
  const port = index >= 0 ? Number(process.argv[index + 1]) || 8791 : 8791
  const server = await startServer({ port })
  console.log(`[repro] stub host: http://127.0.0.1:${String(server.port)}/  （长跑进程，逐行打印 /batch 请求）`)
} else {
  await main()
}

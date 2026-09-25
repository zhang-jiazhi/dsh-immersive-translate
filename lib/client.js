/**
 * @dsh-external/dsh-immersive-translate — client half（就地注入引擎）。
 *
 * 与原版沉浸式翻译同一形态：一张**内容脚本引擎**直接在你正在看的页面里就地替换
 * 文字，而不是另开一个面板让你粘 URL。它在 DSH 窗口内工作——对话正文、界面文案、
 * 侧栏内容都在扫描范围内。
 *
 * 三段构成：
 *   1. 引擎：遍历 DOM → 找"叶子块"→ 批量送宿主翻译 → 就地写回。
 *      内联元素（a/strong/code…）用占位符保护，翻译后原样搬回，不丢链接与代码。
 *   2. MutationObserver：对话是流式渲染的，新内容到来自动补翻（去抖）。
 *   3. 悬浮控制条 + 设置分区：开关、目标语言、显示模式、悬停看原文、用户规则。
 *
 * 显示模式：
 *   - `translation`（默认，仅译文）：译文替换原文，鼠标悬停浮出原文。
 *   - `dual`（双语对照）：原文保留，译文插在其后。
 *
 * Loader-format CJS bundle（`window.__ModuleLoader__.load({id, factory})`），手写无打包器。
 * @module @dsh-external/dsh-immersive-translate/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-immersive-translate',
  factory: (require) => {
    const React = require('react')

    const SETTINGS_URL = '/api/dsh-immersive-translate/settings'
    const BATCH_URL = '/api/dsh-immersive-translate/batch'
    /** 与宿主约定的协议版本：宿主未回报或版本低于它 = 跑的是旧宿主。 */
    const REQUIRED_HOST_PROTOCOL = 2
    /**
     * 宿主最近一次上报的协议版本（1 = 旧宿主，不会上报）。
     *
     * 必须声明在**工厂层**：写入方是 `apply()` 里的 `refreshConfig`，读取方是
     * `createEngine()` 内的 `setEnabled`，而 `createEngine` 并不嵌套在 `apply` 内。
     * 声明在任一侧都会让另一侧读到未声明的隐式全局 —— 守卫判定即失效。
     */
    let hostProtocol = 1
    const TEXT_URL = '/api/dsh-immersive-translate/text'
    /**
     * 内联元素占位符的包裹字符。
     *
     * 必须是机器翻译**原样保留**的形态：实测腾讯交互翻译会改写 `⟦n⟧`
     * （`GitHub⟦0⟧` → `GitHub下载`，甚至整段吞掉占位符导致 `<a>` 丢失），
     * 而 `[[§n]]` 在尾随/中间/开头/双占位符/标点环绕/紧贴字母/中文夹持/多行
     * 等 10 类用例上 10/10 保留。改这里要连带改下面的正则。
     */
    const PH_OPEN = '[[\u00a7'
    const PH_CLOSE = ']]'
    /** 与 PH_OPEN/PH_CLOSE 配套的解析正则（全局）。 */
    const PH_RE = /\[\[\u00a7(\d+)\]\]/g
    const ACCOUNT_URL = '/api/dsh-immersive-translate/account'
    const SERVICES_URL = '/api/dsh-immersive-translate/services'
    const STYLE_ID = 'imt-style'
    /**
     * 本插件在客户端模块系统里的 id。
     *
     * 自己注入的 `<style>` 必须自带 `data-plugin`：模块系统物化一个插件时会把
     * **所有没有该属性的 `<style>`** 划到它名下，等它热重载/卸载时一并删除。
     * 实测本插件重载会误删其它插件（如 drop-path）的样式表，导致对方遮罩层进入
     * 文档流、DSH 主界面整体可滚动（2026-09-25 桌面端事故根因）。
     */
    const MODULE_ID = '@dsh-external/dsh-immersive-translate'
    const DONE_FLAG = 'data-imt-done'

    /** 整棵子树都不翻译的标签。 */
    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP',
      'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO',
      'MATH', 'TEMPLATE', 'OBJECT', 'EMBED', 'MAP', 'AREA', 'SOURCE', 'TRACK',
    ])

    /** 视为"块级"的 display：决定一个元素是段落容器还是内联片段。 */
    const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'table-cell', 'table-caption', 'flex', 'grid', 'flow-root'])

    /** 一次请求最多带多少条（宿主自行分批判处理）。 */
    const CHUNK_ITEMS = 24
    /** 单个 chunk 的字符上限：小批快返回，译文能逐块显示出来。 */
    const CHUNK_CHARS = 2500
    /** 并发 chunk 数：进程内串行更稳，2 条兼顾速度与"不抢占对话"。 */
    /**
     * 默认并发批数。
     *
     * 实测（2026-09-25，transmart）：并发 2 → 8 批 7679ms；并发 6 → 3311ms。
     * 运行时会用配置里的 `freeConcurrency` 覆盖它，这里只是兜底默认。
     */
    const CHUNK_WORKERS = 4
    /**
     * 单批失败后的最大重试次数。
     *
     * 实测免费服务在并发下会偶发 `busy`/网络抖动；不重试就会留下永久空白。
     * 3 次指数退避足以吸收这类瞬时故障（服务端也有各自的退避重试）。
     */
    const BATCH_RETRIES = 3
    /**
     * 单轮扫描最多收多少块。
     *
     * 这**只是单轮上限**，不是总量上限：收满后引擎会立刻再扫一轮继续消化剩余块，
     * 已翻块会被 `DONE_FLAG` 跳过。早期实现把它当成总量上限，导致长会话里超出
     * 240 的块永远轮不到（实测：539 叶块的真实会话，98 个纯英文块只翻了 2 个，
     * 思维链全被挤掉）。单轮有界是为了不让一轮占用太久、也便于中途停止。
     */
    const MAX_BLOCKS_PER_PASS = 240
    /** 换行/空白归一化用。 */
    const WS_RE = /[\t\f\v\u00a0 ]+/g
    /**
     * 记住"用户上次是否开着翻译"。
     *
     * 缺了这个，刷新/重启后开关永远回到关闭——用户点了「翻译此页」以为已经生效，
     * 切到「上下文」等页面却什么都没发生，且毫无提示（2026-09-25 实测踩到）。
     */
    const ENABLED_KEY = 'dsh-immersive-translate:enabled:v1'
    /**
     * 界面开关的本地镜像。
     *
     * 为什么需要它：宿主的配置落盘按 `key in DEFAULTS` 白名单过滤，而宿主是
     * ESM 模块、改动必须重启才生效（实测宿主进程常驻数小时）。若不镜像，
     * 「自动翻译 / 悬浮球」这两个开关在宿主重启前会"保存了但没反应"——正是用户
     * 反馈的"功能未生效"。本地镜像让开关**当场生效**；宿主重启后它会自动让位
     * （宿主明确上报了该键就以后者为准），所以不会形成第二个事实源。
     */
    const PREFS_KEY = 'dsh-immersive-translate:prefs:v1'
    /** 需要本地镜像兜底的键（都是纯界面偏好）。 */
    const MIRRORED_KEYS = ['autoTranslate', 'showBall', 'freeConcurrency']

    /** 读本地镜像（读不到就返回空对象）。 */
    const readLocalPrefs = () => {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /** 写本地镜像（存不了就算了，只在本次会话内存里生效）。 */
    const writeLocalPrefs = (patch) => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readLocalPrefs(), ...patch }))
      } catch {
        /* 隐私模式等场景下存不了，忽略 */
      }
    }
    /** 单个叶子块的字符上限：超过就继续下钻，避免把整页当成一块。 */
    const MAX_LEAF_CHARS = 300

    // ── 样式 ────────────────────────────────────────────────────────────────

    const styles = [
      // 悬浮球（原版形态：贴边缘的圆形控件）
      '.imt-ball-wrap{position:fixed;z-index:2147483000;display:flex;flex-direction:row-reverse;align-items:center;gap:8px;font-family:inherit}',
      '.imt-ball-wrap.imt-ball-right{right:0;top:50%;transform:translateY(-50%);left:auto!important;bottom:auto!important}',
      '.imt-ball{position:relative;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border:none;border-radius:50%;cursor:pointer;touch-action:none;user-select:none;color:var(--dsw-alias-text-on-brand,#fff);background:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 3px 12px rgba(0,0,0,.3);opacity:.82;transition:opacity .15s,transform .15s;padding:0}',
      '.imt-ball:hover{opacity:1;transform:scale(1.06)}',
      '.imt-ball-wrap[data-state="busy"] .imt-ball{background:var(--dsw-alias-bg-layer-3,#525252);cursor:progress}',
      '.imt-ball-wrap[data-state="done"] .imt-ball{background:var(--dsw-alias-state-success-primary,#15803d)}',
      '.imt-ball-wrap[data-state="error"] .imt-ball{background:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.imt-ball-glyph{font-size:17px;font-weight:700;line-height:1}',
      '.imt-ball-badge{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;padding:0 4px;font-size:10px;font-weight:700;border-radius:9px;align-items:center;justify-content:center;color:#fff;background:var(--dsw-alias-state-success-primary,#15803d);box-shadow:0 1px 4px rgba(0,0,0,.35)}',
      // 展开后的纵向操作条
      '.imt-menu{display:none;flex-direction:column;gap:4px;padding:6px;background:var(--dsw-alias-bg-layer-2,#1f1f1f);border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:12px;box-shadow:0 6px 22px rgba(0,0,0,.4)}',
      // 显式开关行：拨杆 + 文案，样式丢失也不影响可用性（定位靠 flex 父级）
      '.imt-set .imt-switch-row{padding:0;background:transparent;border:none}',
      '.imt-set .imt-switch-row:hover{background:transparent}',
      '.imt-set .imt-switch-label{margin-right:10px;color:var(--dsw-alias-text-primary,#fff);font-size:12.5px}',
      '.imt-switch-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:5px 8px;font-size:12.5px;font-family:inherit;color:var(--dsw-alias-text-primary,#fff);background:transparent;border:none;border-radius:7px;cursor:pointer}',
      '.imt-switch-row:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22))}',
      '.imt-switch-label{white-space:nowrap}',
      '.imt-switch-track{position:relative;display:inline-block;flex:0 0 auto;width:30px;height:17px;border-radius:9px;background:var(--dsw-alias-border-l2-darkmode-thin,#525252);transition:background .15s}',
      '.imt-switch-track[data-on="1"]{background:var(--dsw-alias-state-success-primary,#15803d)}',
      '.imt-switch-thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s}',
      '.imt-switch-track[data-on="1"] .imt-switch-thumb{transform:translateX(13px)}',
      '.imt-menu-item{white-space:nowrap;padding:6px 12px;font-size:12.5px;font-family:inherit;text-align:left;color:var(--dsw-alias-text-primary,#fff);background:transparent;border:none;border-radius:7px;cursor:pointer}',
      '.imt-menu-item:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22))}',
      // 操作反馈条：让用户看清"翻了几块/为什么没翻"
      '.imt-toast{position:fixed;z-index:2147483000;left:50%;top:16px;transform:translateX(-50%);max-width:min(520px,86vw);padding:9px 14px;font-size:12.5px;line-height:1.6;font-family:inherit;color:var(--dsw-alias-text-primary,#fff);background:var(--dsw-alias-bg-layer-2,#1f1f1f);border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:9px;box-shadow:0 6px 22px rgba(0,0,0,.4);opacity:0;transition:opacity .18s;pointer-events:none}',
      '.imt-toast[data-show="1"]{opacity:1}',
      // 双语对照模式下插入的译文块
      '.imt-insert{display:block;margin:2px 0 6px;padding-left:8px;border-left:2px solid var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-secondary,#a3a3a3);white-space:pre-wrap;font-family:inherit}',
      // 悬停显示原文的浮层
      '.imt-tip{position:fixed;z-index:2147483000;max-width:min(620px,80vw);max-height:40vh;overflow:auto;padding:9px 11px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-text-primary,#fff);background:var(--dsw-alias-bg-layer-2,#1f1f1f);border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;display:none}',
      '.imt-tip[data-open="1"]{display:block}',
      // 划词浮层
      '.imt-sel{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-text-on-brand,#fff);background:var(--dsw-alias-brand-primary,#3b82f6);border:none;border-radius:14px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:inherit}',
      '.imt-pop{position:fixed;z-index:2147483000;max-width:min(460px,80vw);padding:10px 12px;font-size:13px;line-height:1.65;white-space:pre-wrap;color:var(--dsw-alias-text-primary,#fff);background:var(--dsw-alias-bg-layer-2,#1f1f1f);border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35)}',
      '.imt-pop-src{color:var(--dsw-alias-label-secondary,#a3a3a3);font-size:12px;margin-bottom:6px;max-height:96px;overflow:auto}',
      '.imt-err{color:var(--dsw-alias-state-error-primary,#ef4444)}',
      // 设置分区
      '.imt-set{padding:6px 0 22px;max-width:760px;font-size:13px}',
      '.imt-set-row{display:flex;gap:12px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.14))}',
      '.imt-set-label{width:200px;flex:none}',
      '.imt-set-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.imt-set-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#909090);line-height:1.6}',
      '.imt-ta{width:100%;min-height:96px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;color:inherit;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.3));border-radius:8px;outline:none;resize:vertical;box-sizing:border-box}',
      '.imt-in{height:30px;padding:0 10px;font-size:13px;color:inherit;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.3));border-radius:8px;outline:none;font-family:inherit}',
      '.imt-in:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6)}',
      '.imt-btn{display:inline-flex;align-items:center;height:30px;padding:0 14px;font-size:13px;font-weight:500;color:var(--dsw-alias-text-on-brand,#fff);background:var(--dsw-alias-brand-primary,#3b82f6);border:none;border-radius:8px;cursor:pointer;font-family:inherit}',
      '.imt-btn.ghost{color:var(--dsw-alias-text-primary,inherit);background:transparent;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.35))}',
      '.imt-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.imt-actions{display:flex;gap:8px;align-items:center;padding-top:12px}',
      '.imt-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.imt-dirty{font-size:12px;color:var(--dsw-alias-label-secondary,#999)}',
    ].join('')

    /** 注入一次样式（幂等），并确保归属标记属于本插件。 */
    function ensureStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        if (existing.getAttribute('data-plugin') !== MODULE_ID) existing.setAttribute('data-plugin', MODULE_ID)
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', MODULE_ID)
      style.textContent = styles
      document.head.appendChild(style)
    }

    /** 建元素小工具。 */
    function el(tag, props, children) {
      const node = document.createElement(tag)
      if (props !== null && props !== undefined) {
        for (const key of Object.keys(props)) {
          const value = props[key]
          if (value === undefined || value === null) continue
          if (key === 'class') node.className = String(value)
          else if (key === 'text') node.textContent = String(value)
          else if (key === 'style') node.setAttribute('style', String(value))
          else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
          else node.setAttribute(key, String(value))
        }
      }
      for (const child of children ?? []) {
        if (child === undefined || child === null) continue
        node.append(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      // 自己的 UI 一律不参与翻译。
      node.setAttribute('data-imt-skip', '')
      return node
    }

    // ── 文本判定 ────────────────────────────────────────────────────────────

    /**
     * 归一化空白（比较"内容是否变了"时用）。
     * @param {string} text - 原始文本。
     * @returns {string} 归一化结果。
     */
    function normalize(text) {
      return String(text ?? '').replace(WS_RE, ' ').replace(/\s*\n\s*/g, '\n').trim()
    }

    /**
     * 该文本需要翻译吗（= 值得翻 **且** 还不是目标语言）。
     *
     * 合并成一个入口是刻意的：扫描阶段就要知道"这块到底翻不翻"，
     * 否则单轮 240 块的名额会被不翻的块占用，多轮扫描永远推进不到后面的内容。
     * @param {string} text - 块文本。
     * @param {string} targetLanguage - 目标语言 id。
     * @returns {boolean} true 表示应当翻译。
     */
    function shouldTranslate(text, targetLanguage) {
      const value = normalize(text)
      return worthTranslating(value) && !looksLikeTarget(value, targetLanguage)
    }

    /** 该文本值得翻译吗（跳纯数字/符号/URL/单字符）。 */
    function worthTranslating(text) {
      const value = normalize(text)
      if (value.length < 2) return false
      if (/^(?:[\s\d\p{P}\p{S}]*|\w+:\/\/\S+|\S+@\S+\.\S+)$/u.test(value)) return false
      const letters = value.match(/[\p{L}\p{Script=Han}]/gu)
      return letters !== null && letters.length >= 2
    }

    /**
     * 文本看起来**已经是目标语言**吗？
     *
     * 原版扩展会先判语言再决定是否送翻译。缺了这一步，中文界面会被逐块送去翻成中文：
     * 白烧 token，还可能被模型改写坏（2026-09-24 在真实 DSH 页面实测：27 块纯中文
     * 界面文案全部发起了模型请求）。
     *
     * 判据（目标为中文时）：**只跳过纯中文**。只要句中还夹着成词的其它语言内容，
     * 就应当翻译——这正是用户反馈的 bug 方向（"英文句子中只要夹杂中文就会不被
     * 翻译漏掉，需要过滤掉翻译的只有中文而不是含中文的句子"）。
     *
     * 为什么不用"汉字占比"硬阈值：实测同一占比会有相反期望——
     *   「Hello 世界」      = 2 汉字 / 5 拉丁字母 → 0.286（该翻）
     *   「Token 统计」      = 2 汉字 / 5 拉丁字母 → 0.286（可跳过）
     * 两者占比完全相同，任何阈值都只能二选一。既然用户的优先级是"别漏内容"，
     * 就取高阈值 0.8：只有汉字压倒性多数（拉丁字母仅是零星单位/编号）才跳过。
     *
     * @param {string} text - 归一化后的文本。
     * @param {string} targetLanguage - 目标语言 id（如 `zh-CN`、`en`）。
     * @returns {boolean} true 表示已是目标语言、无需翻译。
     */
    function looksLikeTarget(text, targetLanguage) {
      const value = normalize(text)
      const wantsChinese = targetLanguage.startsWith('zh')
      const han = (value.match(/[\p{Script=Han}]/gu) ?? []).length
      if (!wantsChinese) {
        // 目标不是中文：含汉字才需要翻；纯拉丁（含标识符）视为已是目标语言。
        // 这个分支必须放在下面"都是 0 就返回 false"之前——否则纯英文文本
        // 两个计数都是 0，会被判成"需要翻译"，目标=en 时等于自己翻自己。
        return han === 0
      }
      const hanChars = (value.match(/[\p{Script=Han}·]/gu) ?? []).length
      const latinChars = (value.match(/[\p{Script=Latin}]/gu) ?? []).length
      // 没有汉字：不是中文，必须翻（纯英文/带数字的英文）。
      if (hanChars === 0) return false
      // 纯中文（含数字、标点、符号）：跳过。
      if (latinChars === 0) return true
      // 汉字 + 拉丁字母并存：只有当汉字压倒性多数时才认为是"中文标签"。
      // 反例（这里必须返回 false 才会被翻译）：
      //   "Click the 设置 button to open the repository" 0.06
      //   "Please read the 文档 before you start"        0.07
      //   "Hello 世界"                                   0.29
      //   "Open 设置 and then click 保存"                 0.20
      // 正例（汉字占绝对多数，跳过）：
      //   "上下文合计 185.1k" 0.80   "中文说明 README" 类短标签
      return hanChars / (hanChars + latinChars) >= 0.8
    }

    // ── 引擎 ────────────────────────────────────────────────────────────────

    /**
     * 就地注入翻译引擎。
     *
     * 生命周期与 DSH 的页面一致：构造时开始监听，`dispose()` 时还原所有改动、
     * 摘掉监听与观察者。
     * @param {() => Record<string, unknown>} configOf - 读取当前生效配置。
     * @returns {{ setEnabled: (on: boolean) => void, isEnabled: () => boolean, restoreAll: () => void, dispose: () => void, onStateChange: (fn: (state: object) => void) => () => void }} 引擎接口。
     */
    function createEngine(configOf, refreshConfig) {
      /** 已改动的块：元素 → 原始结构（用于还原与二次翻译）。 */
      const changed = new Map()
      /** 双语模式下插入的译文节点。 */
      const inserted = new Set()
      /** 每次访问给块分配的临时 id（请求期间）。 */
      let seq = 0
      let enabled = false
      let running = false
      /** 正在写 DOM：期间的 MutationObserver 回调要忽略自己的改动。 */
      let applying = false
      /** 去抖计时器。 */
      let timer = null
      /** 取消当前这轮：重建队列时 abort。 */
      let abort = null
      const listeners = new Set()
      const stats = { done: 0, total: 0, failed: 0 }

      /** 状态变化广播（控制条据此换文案）。 */
      function emitState() {
        const snapshot = { enabled, running, done: stats.done, total: stats.total, failed: stats.failed, changed: changed.size }
        for (const fn of listeners) {
          try {
            fn(snapshot)
          } catch (error) {
            console.error('[immersive-translate] listener failed', error)
          }
        }
      }

      /**
       * 这个元素是"块级容器"吗（决定是否继续向下拆）。
       *
       * `display:contents` 的元素自身不产生盒子、但内容参与父级布局，DSH 界面大量
       * 用这种包裹层。它既不是块、也不该被当成叶子——必须继续下钻，否则整个页面会被
       * 合并成一个超长"叶子块"，翻出来是一大坨混杂文本（2026-09-24 真实页面实测）。
       * @param {Node} node - 待判元素。
       * @returns {boolean} true 表示需要继续向它的子元素下钻。
       */
      function isBlockish(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return false
        if (SKIP_TAGS.has(node.tagName)) return false
        let display = ''
        try {
          display = getComputedStyle(node).display
        } catch {
          display = ''
        }
        return BLOCK_DISPLAYS.has(display) || display === 'contents'
      }

      /** 该元素是否整棵跳过。 */
      function isSkipped(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return false
        if (SKIP_TAGS.has(node.tagName)) return true
        if (node.hasAttribute('data-imt-skip')) return true
        const attr = node.getAttribute('translate')
        if (attr === 'no') return true
        if (node.getAttribute('aria-hidden') === 'true') return true
        const editable = node.getAttribute('contenteditable')
        if (editable === '' || editable === 'true') return true
        try {
          if (node.matches('.notranslate,[translate="no"],[contenteditable="true"],.imt-ball-wrap,.imt-ball,.imt-menu,.imt-set,.imt-tip,.imt-sel,.imt-pop,.imt-insert')) return true
        } catch {
          /* 选择器不合法时忽略 */
        }
        return false
      }

      /** 用户规则里的 CSS 选择器：命中则跳过（对应扩展的 excludeSelectors）。 */
      function matchesUserExclude(node) {
        const config = configOf()
        const rules = Array.isArray(config.userRules) ? config.userRules : []
        if (rules.length === 0) return false
        for (const rule of rules) {
          if (rule === null || typeof rule !== 'object') continue
          const list = Array.isArray(rule.excludeSelectors) ? rule.excludeSelectors : []
          for (const selector of list) {
            if (typeof selector !== 'string' || selector.trim() === '') continue
            try {
              if (node.matches(selector) || node.closest(selector) !== null) return true
            } catch {
              /* 非法选择器忽略 */
            }
          }
        }
        return false
      }

      /** 块当前的"内容指纹"：译文写回后用它判断 React 是否又把它换回原文。 */
      function fingerprintOf(node) {
        return normalize(node.textContent)
      }

      /**
       * 收集一个根节点下的待翻译叶子块。
       * @param {Node} root - 起点。
       * @param {Array<HTMLElement>} out - 结果累加。
       */
      function collect(root, out) {
        if (out.length >= MAX_BLOCKS_PER_PASS) return true
        if (root.nodeType === Node.TEXT_NODE) return
        if (root.nodeType !== Node.ELEMENT_NODE) return
        if (isSkipped(root)) return
        if (matchesUserExclude(root)) return

        const record = changed.get(root)
        if (root.hasAttribute(DONE_FLAG)) {
          // 已翻过的块：若内容与当时写回的译文一致，说明还是我们的译文，跳过；
          // 不一致说明 React 重渲染把它换回原文（流式对话常见），重新翻译。
          if (record !== undefined && fingerprintOf(root) === record.dstText) return false
          root.removeAttribute(DONE_FLAG)
        }

        const text = normalize(root.textContent)
        if (text.length < 2) return false

        // 有"带文本的块级子元素"就继续下钻，否则它自己就是叶子块。
        const blocks = []
        for (const child of root.children) {
          if (isBlockish(child) && normalize(child.textContent).length >= 2) blocks.push(child)
        }
        if (blocks.length === 0) {
          // 没有块级子元素，但文本特别长：说明内部还有可供切分的结构（多段文本节点、
          // 长行内序列）。整块送翻译会得到一坨难以对齐的长文，所以继续按子元素下钻。
          if (text.length > MAX_LEAF_CHARS) {
            const descent = []
            for (const child of root.children) if (normalize(child.textContent).length >= 2) descent.push(child)
            if (descent.length > 0) {
              let cut = false
              for (const child of descent) if (collect(child, out) === true) cut = true
              return cut
            }
          }
          // 只给"真正要翻"的叶子块占名额：否则被跳过的块每轮都会重新占满 240 个
          // 名额，多轮扫描永远推进不到后面的内容。注意判定只作用于叶子块——
          // 容器层不能过滤，否则含英文子元素的容器会掐断下钻。
          if (shouldTranslate(text, String(configOf().targetLanguage ?? 'zh-CN'))) out.push(root)
          return out.length >= MAX_BLOCKS_PER_PASS
        }
        let truncated = false
        for (const child of blocks) {
          if (collect(child, out) === true) {
            truncated = true
            break
          }
        }
        return truncated
      }

      /**
       * 把一个块拆成"文本片段 + 内联元素占位符"。
       *
       * 内联元素（a/strong/code…）保留节点本身，翻译时用一个不可见占位符代表它；
       * 模型把占位符原样带回来，我们再把原节点搬回去，于是链接与行内代码不丢。
       * @param {HTMLElement} block - 叶子块。
       * @returns {{ parts: Array<object>, source: string }} 结构与该块送翻译的原文。
       */
      function buildParts(block) {
        const parts = []
        /** 块内所有直属文本节点（简单块走"只改 nodeValue"的安全路径）。 */
        const textNodes = []
        let hasElements = false
        const pushText = (value) => {
          if (value === '') return
          const last = parts[parts.length - 1]
          if (last !== undefined && last.type === 'text') last.value += value
          else parts.push({ type: 'text', value })
        }
        const walk = (node) => {
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              textNodes.push(child)
              pushText(child.nodeValue ?? '')
              continue
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue
            hasElements = true
            // code/pre/kbd/svg 等"原样保留"标签：占位符要留（结构不能丢），
            // 但内部文字**不送翻译**——把 `<code>npm install</code>` 翻掉是错的。
            parts.push({ type: 'el', node: child, frozen: SKIP_TAGS.has(child.tagName) })
          }
        }
        walk(block)
        // 给元素片段编号（占位符 ⟦0⟧ ⟦1⟧ …）。
        let index = 0
        for (const part of parts) {
          if (part.type === 'el') part.placeholder = index++
        }
        const source = parts
          .map((part) => (part.type === 'text' ? part.value : `${PH_OPEN}${String(part.placeholder)}${PH_CLOSE}`))
          .join('')
        // 记下每个文本节点的原值：还原时逐个写回，不改动元素结构。
        const originals = textNodes.map((node) => node.nodeValue ?? '')
        // 内联元素的内部文字也要翻：块级译文里它只是个占位符，翻不到。
        // 这些元素各自作为独立条目送翻译，回填时写进元素内部。
        const elements = []
        for (const part of parts) {
          if (part.type !== 'el') continue
          if (part.frozen === true) continue
          const inner = normalize(part.node.textContent)
          // original 记的是元素内部**原始**文字：还原时要把它写回去。
          elements.push({ node: part.node, placeholder: part.placeholder, text: inner, original: inner, translated: false })
        }
        return { parts, source, textNodes, originals, hasElements, elements }
      }

      /**
       * 把译文写回块。
       *
       * 占位符齐全 → 精确重建（内联元素原样搬回）；缺失 → 退化为纯文本替换，
       * 宁可丢样式也不留半截占位符。
       * @param {HTMLElement} block - 目标块。
       * @param {{ parts: Array<object> }} structure - buildParts 的结果。
       * @param {string} translation - 模型译文。
       * @param {string} source - 送翻译的原文。
       * @param {string} mode - `translation` 或 `dual`。
       */
      function applyTo(block, structure, translation, source, mode) {
        const dst = normalize(translation.replace(PH_RE, ' '))
        if (dst === '') return
        // 悬停浮层要显示"原来的样子"：先用当前 DOM 抓一份纯文本。
        const original = normalize(block.textContent)
        applying = true
        try {
          if (mode === 'dual') {
            // 双语：原文不动，译文作为兄弟节点插在后面。
            let node = block.nextElementSibling
            if (node === null || !node.classList.contains('imt-insert')) {
              node = el('div', { class: 'imt-insert' })
              block.after(node)
            }
            node.textContent = dst
            inserted.add(node)
          } else if (!structure.hasElements && structure.textNodes.length === 1) {
            // 最安全路径：块里只有一个文本节点，直接改它的值。
            // 不触碰元素结构，React 协调时最不容易冲突。
            structure.textNodes[0].nodeValue = dst
          } else if (!structure.hasElements) {
            // 多个文本节点但无内联元素：译文按原文的行数比例铺回去，保住换行。
            const nodes = structure.textNodes
            nodes.forEach((node, index) => {
              node.nodeValue = index === nodes.length - 1 ? dst : ''
            })
          } else {
            // 含内联元素（a/strong/code…）：按占位符精确重建内部结构。
            const fragment = document.createDocumentFragment()
            const re = new RegExp(PH_RE.source, 'g')
            const byIndex = new Map()
            for (const part of structure.parts) if (part.type === 'el') byIndex.set(part.placeholder, part.node)
            let cursor = 0
            let match
            const used = new Set()
            while ((match = re.exec(translation)) !== null) {
              const before = translation.slice(cursor, match.index)
              if (before !== '') fragment.append(document.createTextNode(before))
              const node = byIndex.get(Number(match[1]))
              if (node !== undefined) {
                fragment.append(node)
                used.add(Number(match[1]))
              }
              cursor = match.index + match[0].length
            }
            const tail = translation.slice(cursor)
            if (tail !== '') fragment.append(document.createTextNode(tail))
            // 模型漏掉的占位符：把对应元素追加到末尾，不让它凭空消失。
            for (const [idx, node] of byIndex) if (!used.has(idx)) fragment.append(node)
            block.replaceChildren(fragment)
          }
          block.setAttribute(DONE_FLAG, '1')
          const record = {
            mode,
            original,
            srcText: original,
            // 指纹必须取"写回之后的真实文本"：含内联元素时它与模型译文并不相同
            // （元素文字是另一次请求填进去的），用译文当指纹会导致每轮都判定
            // "内容变了"而无限重译 —— 2026-09-24 真实浏览器测试抓到过。
            dstText: normalize(block.textContent),
            // 还原要用到 structure 的这几个字段；只存 parts 会让 restoreBlock
            // 读 undefined（2026-09-24 真实浏览器测试抓到的 pageerror）。
            parts: structure.parts,
            textNodes: structure.textNodes,
            originals: structure.originals,
            hasElements: structure.hasElements,
            elements: structure.elements,
          }
          changed.set(block, record)
          // 悬停看原文靠这个挂在元素上的引用（事件委托里读它）。
          block.__imtRecord = record
        } finally {
          applying = false
        }
      }

      /** 还原单个块的原始内容。 */
      function restoreBlock(block) {
        const record = changed.get(block)
        if (record === undefined) return
        applying = true
        try {
          if (record.mode === 'dual') {
            const next = block.nextElementSibling
            if (next !== null && next.classList.contains('imt-insert')) {
              inserted.delete(next)
              next.remove()
            }
          } else if (!record.hasElements) {
            // 只改过文本节点：按原值逐个写回，元素结构自始至终没动过。
            const nodes = record.textNodes
            const originals = record.originals
            for (let index = 0; index < nodes.length; index += 1) nodes[index].nodeValue = originals[index] ?? ''
          } else {
            // 含内联元素：先把被翻过的元素内部文字写回原文，再按 parts 顺序搬回去。
            for (const element of record.elements ?? []) {
              if (element.translated === true) {
                element.node.textContent = element.original
                element.translated = false
              }
            }
            const fragment = document.createDocumentFragment()
            for (const part of record.parts) {
              if (part.type === 'text') fragment.append(document.createTextNode(part.value))
              else fragment.append(part.node)
            }
            block.replaceChildren(fragment)
          }
          block.removeAttribute(DONE_FLAG)
          delete block.__imtRecord
        } finally {
          applying = false
        }
        changed.delete(block)
      }

      /** 全量还原（关闭时用）。 */
      function restoreAll() {
        if (abort !== null) abort.abort()
        for (const block of [...changed.keys()]) restoreBlock(block)
        for (const node of [...inserted]) node.remove()
        inserted.clear()
        stats.done = 0
        stats.total = 0
        stats.failed = 0
        emitState()
      }

      /** 把一批块送宿主翻译并写回。 */
      async function translateBatch(blocks, signal) {
        const config = configOf()
        const mode = config.displayMode === 'dual' ? 'dual' : 'translation'
        const language = String(config.targetLanguage ?? 'zh-CN')
        /** 请求条目：每个叶子块一条。 */
        const items = []
        /** 条目 id → { block, structure, source }。 */
        const pending = new Map()
        for (const block of blocks) {
          if (signal.aborted) return
          // 语言判定已在 collect() 阶段做过（名额只给要翻的块），这里只兜一层。
          const blockRaw = normalize(block.textContent)
          if (!shouldTranslate(blockRaw, language)) continue
          const structure = buildParts(block)
          // 块自身的文字（内联元素用占位符代替）作为一条条目。
          const blockText = structure.source.replace(PH_RE, ' ')
          if (worthTranslating(blockText)) {
            const id = `b${String(seq++)}`
            items.push({ id, text: structure.source })
            pending.set(id, { kind: 'block', block, structure })
          }
          // 带内联元素（a/strong/code…）时，它们内部的文字各自作为条目送翻译，
          // 否则这些文字在块级译文里只剩一个占位符，永远翻不到。
          for (const entry of structure.elements) {
            if (!worthTranslating(entry.text)) continue
            if (looksLikeTarget(entry.text, language)) continue
            const id = `e${String(seq++)}`
            items.push({ id, text: entry.text })
            pending.set(id, { kind: 'element', block, structure, entry })
          }
        }
        if (items.length === 0) return
        stats.total += items.length
        emitState()

        // 按字符/条数切小批，逐批并发请求并立即写回：长页面能边翻边看。
        const chunks = []
        let current = []
        let chars = 0
        for (const item of items) {
          const size = item.text.length
          if (current.length > 0 && (current.length >= CHUNK_ITEMS || chars + size > CHUNK_CHARS)) {
            chunks.push(current)
            current = []
            chars = 0
          }
          current.push(item)
          chars += size
        }
        if (current.length > 0) chunks.push(current)

        let cursor = 0
        const worker = async () => {
          while (cursor < chunks.length) {
            if (signal.aborted) return
            const chunk = chunks[cursor]
            cursor += 1
            // 就地退避重试：瞬时失败（宿主 busy、网络抖动）若不重试，这批内容
            // 此后再没有机会被翻译 —— 失败块没打 DONE_FLAG，但 collect 只在页面
            // 变化时才重跑，静置的页面就永久留白（用户看到的"遗漏"）。
            // 不把 chunk 放回共享队列，避免同一批被多个 worker 同时捡起、重复写回。
            let payload = null
            let failure = null
            for (let attempt = 0; attempt <= BATCH_RETRIES; attempt += 1) {
              if (signal.aborted) return
              try {
                const response = await fetch(BATCH_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ items: chunk, targetLanguage: language }),
                  signal,
                })
                payload = await response.json().catch(() => null)
                if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
                failure = null
                break
              } catch (error) {
                failure = error
                if (attempt >= BATCH_RETRIES) break
                const wait = Math.round(400 * 2 ** attempt * (0.75 + Math.random() * 0.5))
                await new Promise((resolve) => setTimeout(resolve, wait))
              }
            }
            if (failure !== null) {
              if (signal.aborted) return
              stats.failed += chunk.length
              console.warn('[immersive-translate] batch failed', failure)
              emitState()
              continue
            }
            const translations = payload.translations ?? {}
            // 一个块可能同时有"块条目"和若干"内联元素条目"：先攒齐再统一写回，
            // 否则块条目先写回会把内联元素从 DOM 上摘走，元素条目就落空了。
            const appliedBlocks = new Map()
            for (const item of chunk) {
              if (signal.aborted) return
              const value = translations[item.id]
              const entry = pending.get(item.id)
              if (entry === undefined) continue
              if (typeof value !== 'string' || value === '') {
                stats.failed += 1
                continue
              }
              if (entry.kind === 'element') {
                // 内联元素的译文：仅译文模式写进元素内部；双语模式交给块条目处理。
                if (mode !== 'dual') {
                  // 必须包在 applying 里：否则这个写操作会被 MutationObserver 当成
                  // 页面自身的变化，又触发一轮无谓扫描。
                  applying = true
                  try {
                    entry.entry.node.textContent = normalize(value)
                    entry.entry.translated = true
                  } finally {
                    applying = false
                  }
                }
                continue
              }
              appliedBlocks.set(entry.block, { entry, value })
            }
            for (const { entry, value } of appliedBlocks.values()) {
              applyTo(entry.block, entry.structure, value, entry.source ?? entry.structure.source, mode)
              stats.done += 1
            }
            emitState()
          }
        }
        // 并发档位跟随配置（设置页「翻译并发」）；实测提高并发能显著缩短总时长。
        const workers = Math.min(Math.max(1, Number(configOf().freeConcurrency) || CHUNK_WORKERS), chunks.length)
        await Promise.all(Array.from({ length: workers }, worker))
      }

      /** 扫一遍页面并把新块翻译掉。 */
      async function run() {
        if (!enabled || running) return
        const roots = []
        const truncated = collect(document.body, roots) === true
        if (roots.length === 0) {
          emitState()
          return
        }
        running = true
        emitState()
        abort = new AbortController()
        try {
          await translateBatch(roots, abort.signal)
        } catch (error) {
          if (error?.name !== 'AbortError') console.warn('[immersive-translate] pass failed', error)
        } finally {
          running = false
          abort = null
          emitState()
        }
        // 单轮收满了：还有剩余块没处理，立刻接着扫下一轮（已翻块会被跳过）。
        // 这是长会话（对话 + 思维链）能翻全的关键。
        if (truncated && enabled && !abort) schedule(0)
      }

      /** 当前统计快照（供提示条汇报）。 */
      const statsOf = () => ({ done: stats.done, total: stats.total, failed: stats.failed })

      // 提示条由悬浮球那边提供；这里只负责在"宿主过旧"时把话说清楚。
      let staleNotified = false
      const notifyStaleHost = () => {
        if (staleNotified) return
        staleNotified = true
        window.dispatchEvent(new CustomEvent('imt-stale-host', {
          detail: { message: '宿主代码未重载：请重启 DSH 后再翻译（当前宿主仍会走你自己的模型，已阻止）。' },
        }))
      }

      /** 去抖调度一次扫描（流式对话会高频触发）。 */
      function schedule(delay = 700) {
        if (!enabled) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void run()
        }, delay)
      }

      const observer = new MutationObserver((records) => {
        if (applying || !enabled) return
        // 只关心"新增了元素/文本"或"文本变了"的变更。
        for (const record of records) {
          if (record.type === 'childList' && (record.addedNodes.length > 0 || record.removedNodes.length > 0)) {
            schedule()
            return
          }
          if (record.type === 'characterData') {
            schedule()
            return
          }
        }
      })

      const onScroll = () => schedule(500)
      const onResize = () => schedule(500)

      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onResize)

      /** 开关。 */
      function setEnabled(on) {
        if (on === enabled) return
        enabled = on
        // 记住状态：下次进页面（或重启 DSH）自动恢复。
        try {
          window.localStorage.setItem(ENABLED_KEY, on ? '1' : '0')
        } catch {
          /* 存不了就只在本次会话生效 */
        }
        if (on) {
          stats.done = 0
          stats.total = 0
          stats.failed = 0
          emitState()
          // 每次开启都先取一次最新配置：否则改完「显示模式」再开关仍是旧模式
          // （真实浏览器测试里表现为切到双语后依然替换原文）。
          void refreshConfig().then(() => {
            // 旧宿主不会上报协议版本：此时翻译仍走旧链路（会消耗用户自己的模型额度），
            // 与"用自带免费服务"的预期相反。宁可不翻，也不偷偷花用户的额度。
            if (hostProtocol < REQUIRED_HOST_PROTOCOL) {
              setEnabled(false)
              notifyStaleHost()
              return
            }
            run()
          })
        } else {
          restoreAll()
        }
        emitState()
      }

      return {
        setEnabled,
        isEnabled: () => enabled,
        statsOf,
        restoreAll,
        dispose() {
          if (timer !== null) clearTimeout(timer)
          if (abort !== null) abort.abort()
          observer.disconnect()
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          restoreAll()
          listeners.clear()
        },
        onStateChange(fn) {
          listeners.add(fn)
          fn({ enabled, running, done: stats.done, total: stats.total, failed: stats.failed, changed: changed.size })
          return () => listeners.delete(fn)
        },
      }
    }

    // ── 悬浮球 + 操作面板 ────────────────────────────────────────────────────

    /**
     * 原版形态的悬浮控件：**右边缘可拖动的圆形悬浮球**，点一下展开纵向操作条。
     *
     * 与"右下角一个写着字的按钮"相比，这个形态有两个实际好处：
     *   - 球贴边且半透明，不遮挡页面内容（原版就是这么做的）；
     *   - 纵向展开操作条后，可以放多个操作（翻译/还原/双语切换/设置），而不是只能切换一个动作。
     *
     * 球的位置持久化到 localStorage，用户可以拖到顺手的地方。
     * @param {ReturnType<typeof createEngine>} engine - 引擎。
     * @param {Function} refreshConfig - 重新拉取配置。
     * @returns {{ root: HTMLElement, dispose: () => void }} 控件。
     */
    function createFloatingBall(engine, refreshConfig, configOf) {
      const POS_KEY = 'dsh-immersive-translate:ball-pos:v1'
      /** 主球图标：原版同款"文/A"形意。 */
      const ball = el('button', { class: 'imt-ball', type: 'button', title: '沉浸式翻译' })
      ball.append(el('span', { class: 'imt-ball-glyph', text: '译' }))
      const badge = el('span', { class: 'imt-ball-badge', style: 'display:none' })
      ball.append(badge)

      /** 展开后的纵向操作条。 */
      const menu = el('div', {
        class: 'imt-menu',
        // z-index/定位一并内联：菜单是相对 root(flex) 排布的兄弟节点，丢样式也不该错位。
        style: 'display:none;position:relative;z-index:2147483001;flex-direction:column;gap:4px',
      })
      // 关键定位内联写死：样式表被误删时也不能进入文档流（否则球跑到文档末尾、视口外）。
      const root = el('div', {
        class: 'imt-ball-wrap',
        style: 'position:fixed;right:0;top:50%;transform:translateY(-50%);left:auto;bottom:auto;z-index:2147483000;display:flex;flex-direction:row-reverse;align-items:center;gap:8px',
      }, [menu, ball])
      let busy = false
      let open = false

      // 位置：默认贴右边缘竖直居中，读过存档则用存档。
      const savedPos = (() => {
        try {
          return JSON.parse(window.localStorage.getItem(POS_KEY) ?? 'null')
        } catch {
          return null
        }
      })()
      const place = (x, y) => {
        root.style.left = `${String(Math.round(x))}px`
        root.style.top = `${String(Math.round(y))}px`
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        // 必须清掉右侧居中用的 transform，否则拖拽后的球会整体上移半个高度。
        root.style.transform = 'none'
      }
      /**
       * 把坐标夹进视口，保证悬浮球整体可见。
       *
       * 存档是绝对像素：换窗口尺寸/分辨率、或收起侧栏后，原本合法的坐标可能落到
       * 视口外，表现为"悬浮球（连同开关）不见了"。这里留 4px 边距。
       * @param {number} x - 期望左边距。
       * @param {number} y - 期望上边距。
       * @returns {{ x: number, y: number }} 夹取后的坐标。
       */
      const clampToViewport = (x, y) => {
        const w = root.offsetWidth || 44
        const h = root.offsetHeight || 44
        return {
          x: Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4)),
          y: Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4)),
        }
      }
      if (savedPos !== null && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
        const safe = clampToViewport(savedPos.x, savedPos.y)
        place(safe.x, safe.y)
      } else {
        root.classList.add('imt-ball-right')
      }

      /** 按引擎状态刷新外观。 */
      const paint = (state) => {
        let mode = 'idle'
        if (busy) mode = 'busy'
        else if (state.enabled && state.changed > 0) mode = 'done'
        else if (state.enabled) mode = 'busy'
        if (state.failed > 0 && state.enabled && !busy) mode = 'error'
        root.setAttribute('data-state', mode)
        const showBadge = state.enabled && state.changed > 0
        badge.textContent = String(state.changed)
        badge.style.display = showBadge ? 'flex' : 'none'
      }
      const off = engine.onStateChange(paint)

      /** 收起操作条。 */
      const closeMenu = () => {
        open = false
        menu.style.display = 'none'
      }

      /**
       * 顶部提示条。
       *
       * 必须要有：否则"没有可翻内容"和"插件坏了"在用户眼里完全一样。
       * 实测场景——DSH 界面是中文，点翻译后 27 块里 23 块被正确跳过，
       * 剩下的是品牌名，用户看到的就是"点了没反应"（2026-09-25）。
       * @param {string} message - 提示文案。
       */
      const toast = el('div', {
        class: 'imt-toast',
        // 注意：这里**不能**内联 opacity（内联优先级高于 `.imt-toast[data-show="1"]`，
        // 会让提示条永远不显示）；显隐由 say()/showToast 同步内联，样式表丢了也有效。
        style: 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s,visibility .18s',
      })
      document.body.append(toast)
      let toastTimer = null
      /** 同步提示条的显隐（内联，样式表被误删也不会失效）。 */
      const showToast = (on) => {
        toast.dataset.show = on ? '1' : '0'
        toast.style.opacity = on ? '1' : '0'
        toast.style.visibility = on ? 'visible' : 'hidden'
      }

      const say = (message) => {
        toast.textContent = message
        showToast(true)
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => {
          showToast(false)
          toastTimer = null
        }, 4200)
      }

      /** 操作条目：点完即收起，避免操作条一直挡着页面。 */
      /**
       * 显式开/关拨杆行。
       *
       * 原版沉浸式翻译的悬浮球里是一个真正的拨杆开关（`aria-pressed` +
       * `switch-thumb`）。本插件原先只在菜单项文案上隐式表达状态
       * （「翻译此页」⇄「还原原文」），用户反馈"开关不见了"，所以补一个一眼可辨的开关行。
       * @returns {HTMLElement} 开关行。
       */
      const switchItem = () => {
        const on = engine.isEnabled()
        const node = el('button', {
          class: 'imt-switch-row',
          type: 'button',
          role: 'switch',
          // 无障碍：读屏能读出当前开/关，而不是只看到一段文字。
          'aria-checked': on ? 'true' : 'false',
          'aria-label': '翻译开关',
        })
        node.append(
          el('span', { class: 'imt-switch-label', text: on ? '翻译已开启' : '翻译已关闭' }),
          el('span', { class: 'imt-switch-track', 'data-on': on ? '1' : '0' }, [el('span', { class: 'imt-switch-thumb' })]),
        )
        node.addEventListener('click', (event) => {
          event.stopPropagation()
          toggle()
        })
        return node
      }

      const item = (label, onClick) => {
        const node = el('button', { class: 'imt-menu-item', type: 'button', text: label })
        node.addEventListener('click', (event) => {
          event.stopPropagation()
          closeMenu()
          onClick()
        })
        return node
      }

      /** 重建操作条（文案随状态变）。 */
      const rebuildMenu = () => {
        const enabled = engine.isEnabled()
        const children = []
        // 开关置顶：它是这个菜单最主要的动作，也是用户找不到的那个"开关"。
        children.push(switchItem())
        children.push(item(enabled ? '还原原文' : '翻译此页', () => {
          toggle()
        }))
        if (enabled) {
          children.push(item('重新翻译', () => {
            engine.restoreAll()
            engine.setEnabled(false)
            window.setTimeout(() => {
              busy = true
              paint({ enabled: true, changed: 0, failed: 0 })
              engine.setEnabled(true)
              busy = false
            }, 0)
          }))
        }
        menu.replaceChildren(...children)
      }

      // 旧宿主拦截：引擎拒绝开启时（会偷偷走用户模型），悬浮球负责把话说明白。
      const onStaleHost = (event) => {
        busy = false
        paint({ enabled: false, changed: 0, failed: 0 })
        rebuildMenu()
        const message = event instanceof CustomEvent ? event.detail?.message : undefined
        say(message ?? '宿主代码未重载：请重启 DSH 后再翻译。')
      }
      window.addEventListener('imt-stale-host', onStaleHost)

      /** 开关翻译。 */
      const toggle = () => {
        if (busy) return
        if (engine.isEnabled()) {
          engine.setEnabled(false)
          paint({ enabled: false, changed: 0, failed: 0 })
          rebuildMenu()
          say('已还原原文。')
          return
        }
        busy = true
        paint({ enabled: true, changed: 0, failed: 0 })
        // 每次开启都重取配置：否则改完显示模式再开关仍是旧模式。
        void refreshConfig().then(() => {
          engine.setEnabled(true)
          busy = false
          paint({ enabled: true, changed: 1, failed: 0 })
          rebuildMenu()
          // 过一小会儿汇报战果：没有反馈时，用户无法区分
          // "页面没有可翻内容" 和 "插件坏了"。
          window.setTimeout(() => {
            if (!engine.isEnabled()) return
            const snapshot = engine.statsOf()
            const target = (configOf().targetLanguage ?? 'zh-CN')
            if (snapshot.done > 0) {
              const failed = snapshot.failed > 0 ? `，${String(snapshot.failed)} 块失败（可点「重新翻译」）` : ''
              say(`已翻译 ${String(snapshot.done)} 块${failed}。悬停译文可看原文。`)
            } else if (snapshot.total === 0) {
              say(`这个页面没有需要翻译的内容（当前目标语言：${target}）。界面本身已是该语言时会全部跳过 — 可到「设置 → 沉浸式翻译」改目标语言。`)
            } else {
              say(`已送出 ${String(snapshot.total)} 块，译文即将出现。`)
            }
          }, 3500)
        })
      }

      // 单击开合操作条；拖动移动位置。用位移阈值区分"点击"和"拖拽"。
      let drag = null
      ball.addEventListener('pointerdown', (event) => {
        drag = { startX: event.clientX, startY: event.clientY, moved: false, originX: 0, originY: 0 }
        const rect = root.getBoundingClientRect()
        drag.originX = rect.left
        drag.originY = rect.top
        ball.setPointerCapture?.(event.pointerId)
      })
      ball.addEventListener('pointermove', (event) => {
        if (drag === null) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
        drag.moved = true
        const target = clampToViewport(drag.originX + dx, drag.originY + dy)
        place(target.x, target.y)
        root.classList.remove('imt-ball-right')
      })
      ball.addEventListener('pointerup', (event) => {
        const state = drag
        drag = null
        ball.releasePointerCapture?.(event.pointerId)
        if (state === null) return
        if (state.moved) {
          // 存下拖后的绝对位置。
          const rect = root.getBoundingClientRect()
          try {
            window.localStorage.setItem(POS_KEY, JSON.stringify({ x: rect.left, y: rect.top }))
          } catch {
            /* 存不了就只在本次生效 */
          }
          return
        }
        open = !open
        menu.style.display = open ? 'flex' : 'none'
        if (open) rebuildMenu()
      })

      // 点外面收起操作条。
      const onOutside = (event) => {
        if (!open) return
        if (root.contains(event.target)) return
        closeMenu()
      }
      document.addEventListener('pointerdown', onOutside, true)

      /**
       * 窗口尺寸变化时把球夹回可见区。
       *
       * 用 `.imt-ball-right`（右侧居中）时由 CSS 兜着，无需处理；拖拽过的球存的是
       * 绝对坐标，窗口一缩小就可能跑到视口外，表现正是"悬浮球/开关不见了"。
       */
      const onViewportChange = () => {
        if (root.classList.contains('imt-ball-right')) return
        const rect = root.getBoundingClientRect()
        const safe = clampToViewport(rect.left, rect.top)
        if (safe.x !== Math.round(rect.left) || safe.y !== Math.round(rect.top)) place(safe.x, safe.y)
      }
      window.addEventListener('resize', onViewportChange)

      document.body.append(root)
      /**
       * 显示/隐藏悬浮球。
       *
       * 隐藏时用 `display:none` 而不是摘除 DOM：引擎的状态监听（onStateChange）与
       * 菜单仍要活着，否则设置页里刚开的自动翻译就没法带动它。
       * @param {boolean} visible - 是否可见。
       */
      const setVisible = (visible) => {
        // 写回 flex 而不是清空：清空会退回样式表的 .imt-ball-wrap{display:flex}，
        // 样式表被误删时就变成 block，排布会错。
        root.style.display = visible ? 'flex' : 'none'
      }

      return {
        root,
        setVisible,
        dispose() {
          off()
          window.removeEventListener('imt-stale-host', onStaleHost)
          window.removeEventListener('resize', onViewportChange)
          document.removeEventListener('pointerdown', onOutside, true)
          if (toastTimer !== null) clearTimeout(toastTimer)
          toast.remove()
          root.remove()
        },
      }
    }

    /**
     * 读回一个 JSON 响应；非 JSON（例如旧宿主返回 401 unauthorized）时不抛语法错误，
     * 而是回一个带 httpStatus 的占位对象，让调用方能给出人话提示。
     *
     * 放在 apply 作用域：划词翻译与设置面板都要用（原先只定义在 createSettings
     * 内部时，划词路径会 ReferenceError）。
     * @param {Response} response - fetch 响应。
     * @returns {Promise<object>} 解析结果或占位对象。
     */
    const readJson = async (response) => {
      const text = await response.text().catch(() => '')
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, httpStatus: response.status, nonJson: text.slice(0, 80) }
      }
    }

    // ── 悬停看原文 ──────────────────────────────────────────────────────────

    /**
     * 仅译文模式下悬停浮出原文。
     *
     * 用事件委托挂在 document 上：译文块数量随时在变，逐个块绑事件既慢又会漏。
     * @returns {() => void} 卸载函数。
     */
    function mountHoverOriginal() {
      const tip = el('div', {
        class: 'imt-tip',
        // 显隐内联写死：`.imt-tip{display:none}` 若随样式表被误删，
        // 它会变成常驻可见的空浮层并进入文档流。
        style: 'position:fixed;z-index:2147483000;display:none;pointer-events:none',
      })
      document.body.append(tip)
      let current = null

      /** 同步浮层显隐（内联，样式表丢失也有效）。 */
      const setOpen = (on) => {
        tip.dataset.open = on ? '1' : '0'
        tip.style.display = on ? 'block' : 'none'
      }

      const show = (target) => {
        const record = target?.__imtRecord
        if (record === undefined) return
        tip.textContent = record.srcText
        setOpen(true)
      }
      const hide = () => {
        setOpen(false)
        current = null
      }
      const onOver = (event) => {
        const target = event.target instanceof Element ? event.target.closest(`[${DONE_FLAG}]`) : null
        if (target === null) {
          hide()
          return
        }
        if (target === current) return
        current = target
        // 位置：贴着块的下沿，越界时上移。
        const rect = target.getBoundingClientRect()
        show(target)
        const tipRect = tip.getBoundingClientRect()
        let top = rect.bottom + 6
        if (top + tipRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - tipRect.height - 6)
        tip.style.top = `${String(Math.round(top))}px`
        tip.style.left = `${String(Math.round(Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, rect.left))))}px`
      }
      document.addEventListener('mouseover', onOver, true)
      document.addEventListener('mouseleave', hide, true)
      window.addEventListener('scroll', hide, true)
      return () => {
        document.removeEventListener('mouseover', onOver, true)
        document.removeEventListener('mouseleave', hide, true)
        window.removeEventListener('scroll', hide, true)
        tip.remove()
      }
    }

    // ── 划词翻译 ────────────────────────────────────────────────────────────

    /**
     * 全局划词：选中 2 字符以上浮出「译」按钮。
     * @returns {() => void} 卸载函数。
     */
    function mountSelectionTranslator() {
      const button = el('button', {
        class: 'imt-sel',
        type: 'button',
        text: '译',
        // 定位内联：样式表被误删时也不能退化成 static 进入文档流。
        style: 'position:fixed;z-index:2147483000;display:none',
      })
      const pop = el('div', {
        class: 'imt-pop',
        style: 'position:fixed;z-index:2147483000;display:none',
      })
      document.body.append(button, pop)
      let pending = null

      const hide = () => {
        button.style.display = 'none'
        pop.style.display = 'none'
      }
      const selectedText = () => {
        const selection = window.getSelection()
        if (selection === null || selection.isCollapsed) return ''
        const text = selection.toString().trim()
        return text.length >= 2 && text.length <= 4000 ? text : ''
      }
      const onMouseUp = () => {
        window.setTimeout(() => {
          const text = selectedText()
          if (text === '') return hide()
          const selection = window.getSelection()
          if (selection === null || selection.rangeCount === 0) return hide()
          const rect = selection.getRangeAt(0).getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return hide()
          pending = text
          button.style.left = `${String(Math.max(8, Math.min(window.innerWidth - 60, rect.left + rect.width / 2 - 16)))}px`
          button.style.top = `${String(Math.min(window.innerHeight - 40, rect.bottom + 8))}px`
          pop.style.display = 'none'
          button.style.display = 'inline-flex'
        }, 10)
      }
      const onMouseDown = (event) => {
        if (pop.contains(event.target) || button.contains(event.target)) return
        hide()
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape') hide()
      }

      button.addEventListener('click', async () => {
        const text = pending
        if (text === null || text === '') return
        button.style.display = 'none'
        pop.replaceChildren(el('div', { class: 'imt-pop-src', text }), el('div', { text: '翻译中…' }))
        pop.style.left = button.style.left
        pop.style.top = button.style.top
        pop.style.display = 'block'
        try {
          const response = await fetch(TEXT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          const data = await readJson(response)
          if (!response.ok || data.ok !== true) {
            throw new Error(data.error ?? (data.nonJson !== undefined ? '宿主未加载账号功能（请重启 DSH）' : `HTTP ${String(response.status)}`))
          }
          pop.replaceChildren(
            el('div', { class: 'imt-pop-src', text }),
            el('div', { text: String(data.text ?? '') }),
          )
        } catch (error) {
          pop.replaceChildren(
            el('div', { class: 'imt-pop-src', text }),
            el('div', { class: 'imt-err', text: error instanceof Error ? error.message : String(error) }),
          )
        }
      })

      document.addEventListener('mouseup', onMouseUp)
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('keydown', onKeyDown)
      return () => {
        document.removeEventListener('mouseup', onMouseUp)
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('keydown', onKeyDown)
        button.remove()
        pop.remove()
      }
    }

    // ── 设置分区（对应扩展的 #developer 配置） ───────────────────────────────

    /**
     * 设置面板：目标语言、显示模式、悬停看原文、自动翻译、用户规则、批量参数。
     * @returns {{ root: HTMLElement, load: Function, dispose: () => void }} 面板。
     */
    function createSettings() {
      let serverConfig = {}

      const status = el('span', { class: 'imt-dirty' })
      const saveBtn = el('button', { class: 'imt-btn', type: 'button', text: '保存' })
      const resetBtn = el('button', { class: 'imt-btn ghost', type: 'button', text: '恢复本页默认' })
      const langSelect = el('select', { class: 'imt-in' })
      const displaySelect = el('select', { class: 'imt-in' })
      displaySelect.append(
        el('option', { value: 'translation', text: '仅译文（替换原文，悬停看原文）' }),
        el('option', { value: 'dual', text: '双语对照（译文插在原文下方）' }),
      )
      /**
       * 拨杆开关控件（与原扩展 settings 里的 switch 同形态）。
       *
       * 用 `role=switch` + `aria-checked` 表达状态：既好看，读屏也能读出来，
       * 而不是靠"复选框打没打勾"暗示。
       * @param {string} label - 开关文案。
       * @returns {{ node: HTMLElement, get: () => boolean, set: (on: boolean) => void }} 控件。
       */
      const makeSwitch = (label) => {
        const node = el('button', { class: 'imt-switch-row', type: 'button', role: 'switch', 'aria-checked': 'false' })
        const text = el('span', { class: 'imt-switch-label', text: label })
        const track = el('span', { class: 'imt-switch-track', 'data-on': '0' }, [el('span', { class: 'imt-switch-thumb' })])
        node.append(text, track)
        let on = false
        const set = (value) => {
          on = value === true
          node.setAttribute('aria-checked', on ? 'true' : 'false')
          track.setAttribute('data-on', on ? '1' : '0')
        }
        node.addEventListener('click', (event) => {
          event.preventDefault()
          set(!on)
          // 复用"未保存"提示逻辑。
          node.dispatchEvent(new CustomEvent('imt-switch-change', { bubbles: true }))
        })
        return { node, get: () => on, set }
      }
      const autoTranslateSwitch = makeSwitch('进入 DSH 后自动开始翻译')
      const showBallSwitch = makeSwitch('显示悬浮球（关掉后靠设置页控制）')
      const batchInput = el('input', { class: 'imt-in', type: 'number', min: '500', max: '12000', step: '100', style: 'width:120px' })
      const concInput = el('input', { class: 'imt-in', type: 'number', min: '1', max: '8', step: '1', style: 'width:120px' })
      const engineSelect = el('select', { class: 'imt-in' })
      engineSelect.append(
        el('option', { value: 'auto', text: '沉浸式翻译自带免费服务（推荐，不占用你的模型）' }),
        el('option', { value: 'transmart', text: '腾讯交互翻译（免费）' }),
        el('option', { value: 'zhipu-free', text: 'GLM-4-Flash 免费网关（需网络可达）' }),
        el('option', { value: 'google', text: 'Google 翻译（免费）' }),
        el('option', { value: 'account', text: '沉浸式翻译账号 Pro（需登录）' }),
        el('option', { value: 'dsh-model', text: '借用 DSH 的模型（会消耗你自己的额度）' }),
      )
      const tokenInput = el('input', { class: 'imt-in', type: 'password', placeholder: '粘贴沉浸式翻译账号令牌' })
      const loginBtn = el('button', { class: 'imt-btn', type: 'button', text: '登录' })
      const logoutBtn = el('button', { class: 'imt-btn ghost', type: 'button', text: '退出登录' })
      const loginStatus = el('span', { class: 'imt-dirty' })
      const servicesRow = el('div', { class: 'imt-svc' })
      const rulesArea = el('textarea', {
        class: 'imt-ta',
        rows: '10',
        spellcheck: 'false',
        placeholder: '[\n  { "matches": "*.twitter.com", "excludeSelectors": [".ad", "footer"] }\n]',
      })

      const row = (label, controls, hint) => el('div', { class: 'imt-set-row' }, [
        el('div', { class: 'imt-set-label', text: label }),
        el('div', { class: 'imt-set-body' }, hint === undefined ? controls : [...controls, el('div', { class: 'imt-set-hint', text: hint })]),
      ])

      const root = el('div', { class: 'imt-set' }, [
        el('div', { class: 'imt-set-hint', style: 'padding:4px 0 12px', text: '插件在 DSH 窗口内就地翻译：直接替换页面上的文字（仅译文模式），鼠标悬停可看原文。这些配置对应浏览器扩展「选项 → 开发者」页的可编辑对象。翻译默认走沉浸式翻译自带的免费服务，不消耗你在 DSH 里配置的模型额度。' }),
        row('翻译引擎', [engineSelect], '默认「自带免费服务」——与原插件一样自带翻译，不消耗你在 DSH 里配置的模型额度。'),
        row('账号', [el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [tokenInput, loginBtn, logoutBtn, loginStatus])], '登录沉浸式翻译账号后可用 Pro 引擎。令牌取自扩展的账号会话，等价于原插件的 user_token。'),
        row('免费服务自检', [servicesRow]),
        row('目标语言', [langSelect]),
        row('显示模式', [displaySelect]),
        row('打开页面自动翻译', [autoTranslateSwitch.node], '开启后进入 DSH 就自动开始翻译，不用每次点悬浮球。'),
        row('悬浮球', [showBallSwitch.node], '关掉悬浮球后界面更干净；翻译仍可由「打开页面自动翻译」或本页的开关控制。'),
        row('单批字符上限', [batchInput], '一次请求最多送多少字符；腾讯交互翻译单批硬上限约 6000 字符，调大反而会整批失败。'),
        row('翻译并发', [concInput], '同时发出几批翻译请求。实测并发 4 比串行快约 4 倍；调太高偶发「服务繁忙」（插件会自动退避重试）。'),
        row('用户规则（JSON）', [rulesArea], '与扩展同写法。命中的页面里，excludeSelectors 指定的区域不会被翻译。'),
        el('div', { class: 'imt-actions' }, [saveBtn, resetBtn, status]),
      ])

      /** 用服务端配置回填表单。 */
      function load(config, languages) {
        serverConfig = config ?? {}
        if (Array.isArray(languages) && languages.length > 0) {
          langSelect.replaceChildren(...languages.map((item) => el('option', { value: item.id, text: item.label })))
        }
        langSelect.value = serverConfig.targetLanguage ?? 'zh-CN'
        displaySelect.value = serverConfig.displayMode === 'dual' ? 'dual' : 'translation'
        // 回填优先用宿主配置；宿主没这个键（未重启）时退回本地镜像。
        const local = readLocalPrefs()
        const autoValue = serverConfig.autoTranslate === undefined ? local.autoTranslate : serverConfig.autoTranslate
        const ballValue = serverConfig.showBall === undefined ? local.showBall : serverConfig.showBall
        autoTranslateSwitch.set(autoValue === true)
        showBallSwitch.set(ballValue !== false)
        engineSelect.value = serverConfig.engine ?? 'auto'
        batchInput.value = String(serverConfig.batchChars ?? 3500)
        concInput.value = String(serverConfig.freeConcurrency ?? local.freeConcurrency ?? 4)
        rulesArea.value = Array.isArray(serverConfig.userRules) && serverConfig.userRules.length > 0 ? JSON.stringify(serverConfig.userRules, null, 2) : ''
        status.className = 'imt-dirty'
        status.textContent = ''
        // 打开设置就同步账号状态：否则用户不知道当前是否已登录。
        void refreshAccount()
      }

      const markDirty = () => {
        status.className = 'imt-dirty'
        status.textContent = '未保存'
      }
      for (const control of [engineSelect, langSelect, displaySelect, batchInput, concInput, rulesArea]) {
        control.addEventListener('change', markDirty)
      }
      // 开关点击后由控件派发这个事件，统一走"未保存"提示。
      for (const sw of [autoTranslateSwitch, showBallSwitch]) sw.node.addEventListener('imt-switch-change', markDirty)

      saveBtn.addEventListener('click', async () => {
        const patch = {
          engine: engineSelect.value,
          targetLanguage: langSelect.value,
          displayMode: displaySelect.value,
          autoTranslate: autoTranslateSwitch.get(),
          showBall: showBallSwitch.get(),
          batchChars: Number(batchInput.value),
          // 这个输入框现在控制的是"免费服务并发"（引擎默认走免费服务）。
          freeConcurrency: Number(concInput.value),
          userRules: [],
        }
        const raw = rulesArea.value.trim()
        if (raw !== '') {
          try {
            const parsed = JSON.parse(raw)
            if (!Array.isArray(parsed)) throw new Error('必须是一个数组')
            patch.userRules = parsed
          } catch (error) {
            status.className = 'imt-err'
            status.textContent = `用户规则不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
            return
          }
        }
        saveBtn.disabled = true
        status.className = 'imt-dirty'
        status.textContent = '保存中…'
        try {
          const response = await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: patch }),
          })
          const data = await readJson(response)
          if (!response.ok || data.ok !== true) {
            throw new Error(data.error ?? (data.nonJson !== undefined ? '宿主未加载账号功能（请重启 DSH）' : `HTTP ${String(response.status)}`))
          }
          // 先落本地镜像，再 load()：load() 回填表单时会用镜像兜底那些宿主还不认的键。
          // 顺序反了的话，首次保存后开关会"自己弹回原位"（镜像还没写，回填读到旧值）。
          writeLocalPrefs({
            autoTranslate: patch.autoTranslate,
            showBall: patch.showBall,
            freeConcurrency: patch.freeConcurrency,
          })
          load(data.config, undefined)
          status.className = 'imt-ok'
          status.textContent = '已保存并生效'
          // 广播给引擎：否则"自动翻译""显示悬浮球"要刷新页面才生效。
          window.dispatchEvent(new CustomEvent('imt-settings-saved'))
        } catch (error) {
          status.className = 'imt-err'
          status.textContent = error instanceof Error ? error.message : String(error)
        } finally {
          saveBtn.disabled = false
        }
      })

      /** 刷新账号状态显示。 */
      const refreshAccount = async () => {
        try {
          const response = await fetch(ACCOUNT_URL, { cache: 'no-store' })
          const data = await readJson(response)
          if (data?.ok !== true) {
            // 旧宿主（未重启）访问不到 /account 路由：明确说清楚，别留一片空白让人猜。
            loginStatus.className = 'imt-dirty'
            loginStatus.textContent = data.nonJson !== undefined ? '宿主未加载账号功能（请重启 DSH）' : (data.error ?? `账号状态不可用（HTTP ${String(data.httpStatus ?? response.status)}）`)
            logoutBtn.disabled = true
            return
          }
          if (data.loggedIn) {
            const user = data.user ?? {}
            loginStatus.className = 'imt-ok'
            loginStatus.textContent = `已登录：${user.nickname ?? user.email ?? user.name ?? '沉浸式翻译账号'}`
            logoutBtn.disabled = false
          } else {
            loginStatus.className = 'imt-dirty'
            loginStatus.textContent = data.needsRelogin === true ? '令牌已失效，请重新登录' : '未登录（Pro 引擎不可用）'
            logoutBtn.disabled = true
          }
        } catch {
          /* 宿主不可达时静默 */
        }
      }

      loginBtn.addEventListener('click', async () => {
        const token = tokenInput.value.trim()
        if (token === '') {
          loginStatus.className = 'imt-err'
          loginStatus.textContent = '请先粘贴令牌'
          return
        }
        loginBtn.disabled = true
        loginStatus.className = 'imt-dirty'
        loginStatus.textContent = '校验中…'
        try {
          const response = await fetch(ACCOUNT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
          const data = await readJson(response)
          if (!response.ok || data.ok !== true) {
            throw new Error(data.error ?? (data.nonJson !== undefined ? '宿主未加载账号功能（请重启 DSH）' : `HTTP ${String(response.status)}`))
          }
          tokenInput.value = ''
          await refreshAccount()
        } catch (error) {
          loginStatus.className = 'imt-err'
          loginStatus.textContent = error instanceof Error ? error.message : String(error)
        } finally {
          loginBtn.disabled = false
        }
      })

      logoutBtn.addEventListener('click', async () => {
        logoutBtn.disabled = true
        try {
          await fetch(ACCOUNT_URL, { method: 'DELETE' })
        } catch {
          /* 忽略 */
        }
        await refreshAccount()
      })

      /** 免费服务自检：点一下探测每个服务通不通。 */
      const runSelfCheck = async () => {
        servicesRow.textContent = '自检中…（会真实请求一次，约数秒）'
        try {
          const response = await fetch(SERVICES_URL, { cache: 'no-store' })
          const data = await readJson(response)
          if (data?.ok !== true) {
            throw new Error(data?.error ?? (data?.nonJson !== undefined ? '宿主未加载自检功能（请重启 DSH）' : `HTTP ${String(response.status)}`))
          }
          const parts = (data.services ?? []).map((item) => `${item.ok ? '✓' : '✗'} ${String(item.label ?? item.id)}${item.ok ? `（${String(item.ms)}ms）` : `：${String(item.error ?? '不可用').slice(0, 60)}`}`)
          servicesRow.textContent = parts.join('　')
        } catch (error) {
          servicesRow.textContent = `自检失败：${error instanceof Error ? error.message : String(error)}`
        }
      }
      servicesRow.addEventListener('click', () => void runSelfCheck())
      servicesRow.style.cursor = 'pointer'

      resetBtn.addEventListener('click', () => load(serverConfig, undefined))

      return { root, load, dispose() {} }
    }

    /** 设置分区 React 包装。 */
    function SettingsView() {
      const host = React.useRef(null)
      React.useEffect(() => {
        const target = host.current
        if (target === null) return undefined
        const settings = createSettings()
        target.append(settings.root)
        fetch(SETTINGS_URL, { cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (data?.ok === true) settings.load(data.config, data.languages)
          })
          .catch(() => {})
        return () => {
          settings.dispose()
          settings.root.remove()
        }
      }, [])
      return React.createElement('div', { ref: host })
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────

    const inject = ['slots']

    /**
     * 客户端入口：装引擎、控制条、悬停原文、划词、设置区。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // 配置先取一次：自动翻译开关与显示模式都由它决定。
      let config = { targetLanguage: 'zh-CN', displayMode: 'translation', autoTranslate: false, showBall: true, freeConcurrency: 4 }
      let engine = null

      ctx.effect(() => {
        ensureStyles()
        return () => {
          document.getElementById(STYLE_ID)?.remove()
        }
      }, 'immersive-translate: styles')

      /**
       * 取最新配置（失败则保留现有值），并记录宿主协议版本。
       *
       * 旧宿主不会回报 `hostProtocol`：那种情况下翻译仍会走旧链路（用户的模型），
       * 与"用自带免费服务"的预期不符，所以这里记下来，开启翻译时明确拦一次。
       */
      const refreshConfig = async () => {
        try {
          const response = await fetch(SETTINGS_URL, { cache: 'no-store' })
          const data = await response.json()
          if (data?.ok === true) {
            const hostConfig = data.config ?? {}
            // 宿主没上报镜像键（旧宿主 / 尚未重启）时，用本地镜像兜底，
            // 保证两个开关当场生效；宿主一旦上报，就以宿主为唯一事实源。
            const local = readLocalPrefs()
            const overlay = {}
            for (const key of MIRRORED_KEYS) {
              if (hostConfig[key] === undefined && local[key] !== undefined) overlay[key] = local[key]
            }
            config = { ...config, ...hostConfig, ...overlay }
            hostProtocol = typeof data.hostProtocol === 'number' ? data.hostProtocol : 1
          }
        } catch {
          /* 取不到就按现有配置继续 */
        }
        return config
      }

      ctx.effect(() => {
        engine = createEngine(() => config, refreshConfig)
        const pill = createFloatingBall(engine, refreshConfig, () => config)
        const hover = mountHoverOriginal()
        const selection = mountSelectionTranslator()
        /** 读上次的开关状态（用户手动开过就记住）。 */
        const rememberedEnabled = () => {
          try {
            return window.localStorage.getItem(ENABLED_KEY) === '1'
          } catch {
            return false
          }
        }

        /**
         * 首次挂载：决定要不要自动开始翻译。
         *
         * 「自动翻译」开着、或上次会话是开着的，就自动开翻。
         */
        const boot = () => {
          pill.setVisible(config.showBall !== false)
          if (config.autoTranslate === true || rememberedEnabled()) engine.setEnabled(true)
        }

        /**
         * 设置保存后：只把"能看出变化"的部分应用下去。
         *
         * 刻意**不**在这里调 `setEnabled(false)`：用户可能正手动翻着，去改个
         * 目标语言就会把翻译关掉。关掉「自动翻译」只影响下次进入，不影响当前页
         * （与原扩展一致）。打开「自动翻译」则立刻开翻，符合预期。
         */
        const applyOnSave = () => {
          pill.setVisible(config.showBall !== false)
          if (config.autoTranslate === true && !engine.isEnabled()) engine.setEnabled(true)
        }

        void refreshConfig().then(boot)
        // 设置页改完保存后，这里能收到通知即时生效（否则要刷新页面才看到变化）。
        const onSettingsSaved = () => {
          void refreshConfig().then(applyOnSave)
        }
        window.addEventListener('imt-settings-saved', onSettingsSaved)
        return () => {
          window.removeEventListener('imt-settings-saved', onSettingsSaved)
          selection()
          hover()
          pill.dispose()
          engine?.dispose()
          engine = null
        }
      }, 'immersive-translate: inline engine')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'immersive-translate',
        order: 46,
        label: '沉浸式翻译',
      }, SettingsView)), 'immersive-translate: settings section')
    }

    return { apply, inject }
  },
})

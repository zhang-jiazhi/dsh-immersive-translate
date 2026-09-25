/**
 * 正文抽取器测试。
 *
 * 覆盖的是"读了会不会出错"而不是"实现是否好看"：脚本里的假标签不能进正文、
 * 代码块要保留原文但标记不可译、隐藏元素不能被当成可见正文、嵌套同名块不能
 * 产出重复文本、用户规则要按扩展口径命中。
 */
import assert from 'node:assert/strict'
import { decodeEntities, extractBlocks, extractTitle, isBoilerplate, matchUrl, resolveRule, splitLong, textOf, worthTranslating } from '../lib/extract.js'

let passed = 0
/** 跑一条断言并计数。 */
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${String(passed)} - ${name}`)
}

check('实体解码：命名 / 十进制 / 十六进制 / 未知原样', () => {
  assert.equal(decodeEntities('a &lt; b &#65; &#x42; &nbsp;'), 'a < b A B  ')
  assert.equal(decodeEntities('&unknown; &amp;'), '&unknown; &')
})

check('textOf 压平内联标记并保留换行', () => {
  assert.equal(textOf('<p>Hello <strong>bold</strong></p><p>Next</p>'), 'Hello bold Next')
  assert.equal(textOf('<!-- c -->x'), 'x')
})

check('抽取标题', () => {
  assert.equal(extractTitle('<html><head><title>Hi &amp; Bye</title></head></html>'), 'Hi & Bye')
  assert.equal(extractTitle('<html></html>'), '')
})

check('脚本里的假标签不是正文', () => {
  const html = '<html><body><script>var s = "<p>fake paragraph</p>"</script><p>real text here</p></body></html>'
  const texts = extractBlocks(html).map((block) => block.text)
  assert.deepEqual(texts, ['real text here'])
})

check('nav/footer/head 不产出块', () => {
  const html = '<html><head><title>T</title></head><body><nav>Home About</nav><p>Body text</p><footer>Copyright 2026</footer></body></html>'
  assert.deepEqual(extractBlocks(html).map((block) => block.text), ['Body text'])
})

check('代码块保留原文但标记不可翻译', () => {
  const html = '<body><p>Explain this code</p><pre><code>const x = 1</code></pre></body>'
  const blocks = extractBlocks(html)
  assert.deepEqual(blocks.map((block) => [block.kind, block.translatable]), [['p', true], ['pre', false]])
  assert.equal(blocks[1].text, 'const x = 1')
})

check('隐藏元素保留文本但不可翻译', () => {
  const html = '<body><p>Shown text</p><div style="display:none">Secret text here</div><span hidden>Also hidden</span></body>'
  const blocks = extractBlocks(html)
  assert.equal(blocks[0].translatable, true)
  for (const block of blocks.slice(1)) assert.equal(block.translatable, false, `expected hidden block not translatable: ${block.text}`)
})

check('嵌套同名块不产生重复文本', () => {
  const html = '<body><li><p>Only once</p></li></body>'
  const texts = extractBlocks(html).map((block) => block.text)
  assert.deepEqual(texts, ['Only once'])
})

check('属性值里的 > 不会截断标签', () => {
  const html = '<body><div data-x="a > b" class="c">Visible text</div></body>'
  assert.deepEqual(extractBlocks(html).map((block) => block.text), ['Visible text'])
})

check('纯数字/符号块不可翻译', () => {
  assert.equal(worthTranslating('12'), false)
  assert.equal(worthTranslating('—'), false)
  assert.equal(worthTranslating('https://example.com/a/b'), false)
  assert.equal(worthTranslating('Hello world'), true)
  assert.equal(worthTranslating('中文段落'), true)
})

check('超长文本按上限切分且不丢内容', () => {
  const text = '句子。'.repeat(600)
  assert.ok(text.length > 1200, 'fixture must exceed the cap')
  const parts = splitLong(text)
  assert.ok(parts.length > 1, 'expected more than one part')
  for (const part of parts) assert.ok(part.length <= 1200, `part too long: ${String(part.length)}`)
  assert.equal(parts.join(''), text)
})

check('无标点的超长单句被硬切', () => {
  const text = 'a'.repeat(2500)
  const parts = splitLong(text)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(''), text)
})

check('maxBlocks 生效', () => {
  const html = `<body>${Array.from({ length: 50 }, (_, i) => `<p>Paragraph number ${String(i)}</p>`).join('')}</body>`
  assert.equal(extractBlocks(html, { maxBlocks: 10 }).length, 10)
})

check('URL 规则按扩展口径匹配', () => {
  assert.equal(matchUrl('https://www.google.com/search?q=x', 'www.google.com'), true)
  assert.equal(matchUrl('https://twitter.com/a', '*.twitter.com'), true)
  assert.equal(matchUrl('https://mobile.twitter.com/a', '*.twitter.com'), true)
  assert.equal(matchUrl('https://x.com/a', '*.facebook.com'), false)
  assert.equal(matchUrl('https://anything.example/', '<all_urls>'), true)
  assert.equal(matchUrl('https://a.example/x', ['nope.example', 'a.example']), true)
  assert.equal(matchUrl('https://a.example/x', 'https://a.example/*'), true)
  assert.equal(matchUrl('https://a.example/x', 'https://b.example/*'), false)
})

check('用户规则命中第一条并带出选择器', () => {
  const rules = [
    { matches: 'nope.example', selectors: ['.a'] },
    { id: 'twitter', matches: ['*.twitter.com'], selectors: ['.text', ''], excludeSelectors: ['footer'] },
  ]
  const hit = resolveRule('https://twitter.com/home', rules)
  assert.deepEqual(hit, { matched: true, selectors: ['.text'], excludeSelectors: ['footer'], ruleId: 'twitter' })
  assert.deepEqual(resolveRule('https://example.com', rules), { matched: false, selectors: [], excludeSelectors: [], ruleId: null })
  assert.deepEqual(resolveRule('https://example.com', null), { matched: false, selectors: [], excludeSelectors: [], ruleId: null })
})

check('真实页面样本：正文顺序稳定', () => {
  const html = `<!DOCTYPE html><html><head><title>Sample</title><style>body{}</style></head>
<body><header><h1>Site name</h1></header>
<article>
  <h1>Article title</h1>
  <p>First paragraph of the article.</p>
  <h2>Section</h2>
  <ul><li>Point one</li><li>Point two</li></ul>
  <blockquote>A quotation.</blockquote>
</article></body></html>`
  const blocks = extractBlocks(html)
  assert.deepEqual(blocks.map((block) => block.kind), ['h1', 'h1', 'p', 'h2', 'li', 'li', 'blockquote'])
  assert.equal(blocks[1].text, 'Article title')
})

check('样板文本被判定为噪音', () => {
  // MDN 类站点会在正文前放一批无障碍跳转链接，实测占了前 5 段。
  for (const text of ['Skip to main content', 'Toggle navigation', 'Back to top', 'menu', 'Search', 'Sign in', 'Cookie settings', 'Advertisement']) {
    assert.equal(isBoilerplate(text), true, `expected boilerplate: ${text}`)
  }
  // 正常句子不能被误伤（只做整段精确匹配，不做子串包含）。
  for (const text of ['Learn how to skip to main content in HTML', 'This page describes the Fetch API', 'Search results for immersive translation', '12']) {
    assert.equal(isBoilerplate(text), false, `expected NOT boilerplate: ${text}`)
  }
})

check('抽取器丢弃样板块但保留正文', () => {
  const html = `<body>
    <li>Skip to main content</li>
    <li>Toggle navigation</li>
    <h1>Fetch API</h1>
    <p>The Fetch API provides an interface for fetching resources.</p>
    <li>Back to top</li>
  </body>`
  const texts = extractBlocks(html).map((block) => block.text)
  assert.deepEqual(texts, ['Fetch API', 'The Fetch API provides an interface for fetching resources.'])
})

check('样板块不占用 maxBlocks 额度', () => {
  const noise = Array.from({ length: 30 }, () => '<li>Skip to main content</li>').join('')
  const body = Array.from({ length: 8 }, (_, i) => `<p>Real paragraph number ${String(i)} with enough text.</p>`).join('')
  const blocks = extractBlocks(`<body>${noise}${body}</body>`, { maxBlocks: 5 })
  // 若样板先占额度，这里只会剩 5 段噪音或不足 5 段真正文。
  assert.equal(blocks.length, 5)
  for (const block of blocks) assert.ok(block.text.startsWith('Real paragraph'), `noise leaked: ${block.text}`)
})

console.log(`\n${String(passed)} extractor checks passed`)

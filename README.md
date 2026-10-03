# dsh-immersive-translate

把「沉浸式翻译」移植成 DSH 桌面版插件：**在 DSH 窗口里就地翻译**——直接替换页面上的文字（含对话与思维链），鼠标悬停看原文。

**整个插件就是一个开关**：点右下角悬浮球 → 拨杆开/关。没有设置页、引擎列表、账号、自检等任何页面——配置走 profile patch 或 `settings.json`（重启生效），默认值开箱即用。

- 翻译默认走**腾讯交互翻译**（免费、免登录、不消耗 DSH 模型额度）
- 模型工具 `translate_text` / `translate_page` 仍对 agent 可用（读外文片段/整页）

---

## 使用

1. 点右下角**圆形悬浮球**（可拖动、位置记忆）→ 拨杆开启 → 页面文字就地变译文
2. 再拨一次 = 关闭并**还原全部原文**（结构一字不差）；开启状态下菜单里多一个「重新翻译」（清掉标记重扫，补翻失败块用）
3. 悬停译文可看原文；选中文字浮出「译」做划词翻译
4. 有英文内容才有得翻：DSH 界面本身是中文，会被正确跳过

## 配置（可选，改文件重启生效）

`~/.dsh/immersive-translate/settings.json`（或 profile patch 的 config 段），全部键见 `GET /api/dsh-immersive-translate/settings` 的 `defaults`。常用的：

| 键 | 默认 | 说明 |
|---|---|---|
| `targetLanguage` | `zh-CN` | 目标语言（9 种可选） |
| `engine` | `auto` | `auto`（免费服务回退链）/ `transmart` / `google` / `account`（需 token）/ `dsh-model`（耗你的额度） |
| `displayMode` | `translation` | `dual` = 双语对照（译文插在原文下方） |
| `autoTranslate` | `false` | 进入 DSH 自动开始翻译 |
| `freeConcurrency` | `4` | 免费服务并发批数 |
| `userRules` | `[]` | 同扩展写法，`excludeSelectors` 命中区域不翻 |

---

## 完成标准与验证结果

| 项 | 证据 |
|---|---|
| **一个开关** | 悬浮球菜单只剩拨杆（`role=switch` + `aria-checked`，读屏可读）+「重新翻译」；设置页/引擎列表/账号/自检页面已全部移除，宿主对应路由（/fetch、/translate、/account、/services、settings POST）一并删除——HTTP 暴露面只剩 settings GET、batch、text 三条 |
| 自带免费服务 | 腾讯交互翻译实测可用；回退链 `transmart → zhipu-free → google`；免费服务失败默认**不回退**到你的模型 |
| 协议 v3 | 免费服务链内对**回显原文/漏掉**的条目自动换下一个服务重试；换遍仍只剩回显（专名）按最终答案落定。客户端完全信任 v3 响应，旧宿主被 stale-host 闸拦下 |
| 就地翻译 | 真实页面上文字就地替换；悬停浮出原文；还原一字不差（含链接、行内代码、嵌套结构、表格） |
| 表格/嵌套结构 | 表格按 td/th 单元格翻译、结构不塌；`<a><code>`、`<strong><em>` 等嵌套内联逐层翻译不压扁（格式破坏修复） |
| 长会话/思维链 | 单轮 240 块上限会继续多轮直到消化完；600 块长页全翻 |
| 只跳过纯中文 | 夹英文的句子照常翻译 |
| 批失败自动重试 | 客户端 3 次指数退避 + 服务端按服务换家；漏译走 `missing` 不被 done 锁死，主动补翻 |
| 测试 | `npm test`：抽取器 19 + 宿主 32 + 硬失败回归 + 真实浏览器 34，exit 0 |

---

## 排查

| 症状 | 处理 |
|---|---|
| 弹「宿主代码未重载：请重启 DSH」 | 宿主进程还是旧代码（会走旧链路），被守卫拦下——重启即可 |
| 点开关没反应 | 页面已是目标语言（中文界面+目标中文会跳过）；提示条会说清"没有需要翻译的内容" |
| 有些句子没翻译 | 本该跳过的是纯中文；确有整块没动的，看提示条失败计数（瞬时故障已自动重试） |
| 找不到悬浮球 | 球会被夹回视口内；或窗口太小/被拖出——重启后位置会重新夹取 |
| 想改目标语言/引擎 | 编辑 `~/.dsh/immersive-translate/settings.json`（或 profile patch），重启 |

---

## 设计要点（为什么是这样）

- **为什么默认不用 DSH 模型**：免费服务（transmart）实测可用且不耗额度；失败默认不回退到你的模型（避免悄悄扣额度），要回退显式配 `allowModelFallback`。
- **为什么占位符是 `[[§n]]`**：内联元素送翻时占位，译文回来按占位符原样搬回节点——实测腾讯会改写旧标记 `⟦n⟧` 导致链接丢失。
- **为什么协议升到 v3**：免费服务把整句原文原样吐回时，旧链路重试打的是同一家（结果不变，纯浪费），专名还会被客户端误判成永久失败。v3 在服务链内换家重试、换遍仍回显的按最终答案落定；客户端信任响应、打 done 收敛。宁可在重启前不翻，也不悄悄跑旧链路。
- **为什么表格/嵌套内联曾经坏**：`collect()` 按 CSS display 判块级，表格系 display 缺失 → 与段落混排的表整张跳过、独立短表被压平；元素条目直接写 textContent → 嵌套结构压扁。现按单元格/递归条目处理，深度上限 3 层，超出保原文不破坏。
- **还原为什么可靠**：写回前抓真原文（部分翻过再重扫时从旧记录恢复最初原文），还原按单元从深到浅恢复。

## 测试

```
lib/index.js     宿主半：3 条路由 + 2 个工具 + 免费服务适配层
lib/client.js    客户端半：就地注入引擎 + 悬浮球开关 + 悬停原文 + 划词
lib/extract.js   无依赖 HTML→块抽取（translate_page 工具用）
test/extract.test.mjs    19 项
test/host.test.mjs       32 项
test/inject-browser.mjs  34 项（真实 Chromium）
test/hardfail.test.mjs   硬失败收敛回归
```

`npm test` 跑全部（exit 0）；`npm run test:fast` 跳过浏览器组。

## 开发三道硬约束（都踩过，都有回归测试）

1. `inject` 必须列全用到的服务，否则整块回滚（路由与工具全挂不上）
2. 每个 `register` 必须包在 `ctx.effect(...)`，否则热重载残留孤儿路由
3. `lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id 必须等于 `package.json` 的 `name`

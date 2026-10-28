# dsh-clarify · 澄清模式 0.4.0

> 开工之前，先把需求问清楚。
> 打开这个开关，AI 会先复述你的要求 → 用**自带的访谈面板**逐题问清真正会改变做法的点（每题独立选项 + 独立输入框）→ 给你一张**需求卡** → 你点「确认开工」之后才动手。

一句话：把「返工三次」换成「问三个问题」。

---

## 它解决什么

宽泛的需求不是 AI 理解不了，而是**它还缺几个只有你知道的答案**。它按最省事的默认值猜，你看到成品不对，再描述一遍差异——这一来一回，比一次问清楚贵得多。

澄清模式把这个来回挪到开工之前，而且**把「问」本身做成能用的东西**：多个问题不再挤进一个回答框，每题都有自己的选项和输入框。

---

## 0.2 的核心：访谈面板

内置问答工具一次给一批问题时，界面上只有一个回答框——问题一多，人就只能挑着写，剩下的被忽略。这是 0.2 重做的原因：**插件自己渲染提问**。

打开开关后，AI 提问会出现在**输入框上方的面板**里：

- **每题一块**：题号 + 标题（如「交付物」）+ 问题 + 说明。
- **每题自己的选项**：2–4 个具体选项，**第一个是推荐值、默认选中**；点一下就是答案。
- **每题自己的输入框**：不想选就自己写；写了会覆盖选项。
- **顶部进度**：「3 题」；可折叠，不抢焦点。
- **底部**：`全部按推荐` / `提交答案`。直接提交＝全按推荐。
- **跳过**：让 AI 用它的默认值补上假设、直接开工——不强迫回答。
- **×**：关掉面板，把这一轮交还给你（AI 停下，等你下一条消息）。

面板的状态存在**宿主**，不在浏览器里：刷新页面、切走再切回来，问题还在、答案不丢。AI 在等你的同时，不会自己往下干。

### 需求卡确认也走同一个面板

AI 问完会写一张需求卡，用**同一块面板**请你确认：`确认开工` / `还要再问` / `我自己改`，以及一个自由输入框（写你要改什么）。确认后卡片存档，显示在每一轮的提示词里；旁边的「卡」按钮随时能翻出来看。

**新任务边界**：卡片批准后，锚里写着一条硬判断——换对象 / 换交付物 / 说「下一个」都是新任务，必须先重新澄清、重新提交，旧卡在新卡批准前不作数；而对上一次结果的修改（「第 2 节改成…」）直接做。卡片面板底部的主按钮就是「开始新任务」，一键清卡。

### 别的会话在等回答，侧栏会亮

面板只在你正开着的会话里渲染。如果模型在**另一个会话**里提问，侧栏底部会出现 `⏳ 1`：告诉你有个会话被卡住了，切过去就能答。它只读一个「有几组待答」的聚合接口，不参与面板心跳。

### 没有面板的环境自动退回

TUI 或 headless 里没有这块面板，宿主会检测到「没有客户端在轮询」，自动退回内置问答，并且**一次只问一题**——绝不把三个问题塞进一个回答框。

---

## 需求卡落盘

批准的需求卡除了进 `state.json`（给模型读），还会落成一份 markdown 文件（给人读）：

- 默认路径：`<会话 cwd>/.dsh/clarify/card-YYYYMMDD-HHMM-<标题>.md`。和项目一起进版本库，下次开会话、换个 agent 也能找到。
- 文件名保留中文，去掉 Windows 不允许的字符；同一分钟内同名卡自动加 `-2`、`-3`，不覆盖。
- 内容是 `# 标题` + 批准时间/会话 + 卡片正文；写入用临时文件 + rename，不会留下半张卡。
- 想关掉：`cardFile: false`（偏好仍会记录，只是不写文件）。
- 想集中放：`cardFileDir: 'D:/cards'`（覆盖默认的 `<cwd>/.dsh/clarify`）。
- 写文件失败只记 warning，**不影响批准本身**——卡已经在 `state.json` 里，工具返回的 `cardPath` 为空，模型会在回复里说明。
- `clarify_brief` 的返回值多了 `cardPath`；render 在批准时补一句「需求卡已落盘：`<path>`」。

---

## 记忆复查

`cards.json`（默认和 `state.json` 同目录）保留**最近 8 张**批准过的卡。下一轮澄清时，未批准会话的提示词段落 = 访谈脚本 + 最近 **3** 张卡的标题、批准日期与前 **300** 字：

- **只作参考**：已定的事不要再问，推荐值优先沿用；旧卡永远不会被当成当前需求。
- 已批准的会话读的仍是本轮卡片的锚，不会混入旧卡。
- 空档案时提示词与 0.2 完全一致（一个字节都不多）。
- `GET /api/clarify/health` 的 `cards` 就是档案条数；0 表示新装或还没批准过。

---

## 验收清单：需求卡自带勾选项

`clarify_brief` 除了卡片正文，还能收 `checklist`（**最多 6 条**，3–5 条最好）。清单会被追加到卡片末尾：

```markdown
**验收清单**
- [ ] PDF 能打开
- [ ] 页数正确
```

- 条目在**确认面板里先给用户看**；批准后进入 `state.json` 的卡、每一轮的提示词锚、`cards.json`，以及落盘的 `.md` 文件。
- 已批准的锚会要求：开工后按清单逐条自查，完成时在回复里逐条说明做没做到。
- 条目要能勾选（「8 页以内」「图注齐全」），不要写口号；空卡配清单不成立。

## 信息类型：goal 只在开工前问

每题可以声明 `kind`：

| kind | 含义 | 时机 |
| --- | --- | --- |
| `goal` | 到底要什么 / 成功标准 | **只在动手前** |
| `input` | 素材与细节（默认） | 任何时候 |
| `constraint` | 限制（时间、技术栈、格式） | 任何时候 |
| `context` | 背景 | 任何时候 |

插件通过宿主的 `session/event` 观察 `tool/call`：一旦见过 `write` / `edit` / `apply_patch` / `multi_edit` / `str_replace` / `create_file`（见 `lib/work-tracker.js`），这个会话就算**已开工**。之后同一会话的 `goal` 题会被丢弃，模型会读到「会话已经开始动手，goal 类问题已过期，已丢弃 N 题」；全是 goal 题时直接返回 `invalid`，告诉它别再问目标。

只读工具（`read`、`grep`、`bash` 里的只读命令等）**不算**开工。追踪只在内存里：进程重启后重新判断，不持久化。

## 快问 / 完整两种访谈

- `mode=quick`：只问**第一题**，其余丢弃并说明「快问模式只问 1 题，N 题已丢弃」；面板顶部显示「快问」徽章。适合小任务。
- `mode=full`：走完整批次（默认）。
- 部署级默认由 `interviewMode` 配置决定，工具参数里的 `mode` 优先。
- 过滤顺序固定：impact → goal → quick 上限 → 每批上限，所以被丢弃的题不会占掉真正问题的名额。

## focus：只问某一个方面

用户说「只问格式 / 只问页数」时，模型把 `focus: '格式'` 传给 `clarify_ask`；面板会显示「只问：格式」标签。它是一个**给人看的标签**，不改变过滤逻辑，也不会限制问题内容。

## 指标：`node tools/stats.mjs`

每次 `clarify_ask`（`kind=questions`）和 `clarify_brief`（`kind=review`）执行完，都会往 `$DSH_HOME/clarify/metrics.json`（与 `state.json` 同目录）写一条记录，最多保留 500 条：

```json
{ "sessionId": "…", "kind": "questions", "asked": 2, "dropped": 1,
  "status": "answered", "ms": 1200, "at": 1761000000000 }
```

- `asked` 是真正展示给用户的题数；`dropped` 是过滤/截断掉的题数；`ms` 是本次工具执行耗时。
- 只记录指标模块能表达的 6 种结果：`answered` / `dismissed` / `skipped` / `timeout` / `no_client` / `off`。`invalid`（空卡、全被过滤）和 `busy` 不代表一次真实访谈，不落记录。
- `review` 记录：确认卡本身算 **1 个问题**（answered/dismissed/skipped）；`off`/`no_client` 记 0 个。
- 所以 `summary.interviews` 统计**所有记录**（含 `off` 和 review）；`avgQuestions` 是「每次交互平均提问数」。只看提问本身的分布，请用 `--json` 后按 `kind` 过滤。
- 记录失败只记 warning，**不影响访谈与确认**；漏记一条不影响插件工作。
- `GET /api/clarify/health` 的 `interviews` 就是记录条数。

```powershell
node tools/stats.mjs                      # 中文报告，默认路径
node tools/stats.mjs --file D:/my/metrics.json
node tools/stats.mjs --json               # 原始 summary（给脚本/排查用）
```

---

## 提示词是「问题优先」的

打开后 AI 拿到的不是「请多问问题」，而是明确顺序：

- **先答后问**：先复述「要做的是 X，用来 Y，交付成 Z」；能自己查的自己查。
- **用 `clarify_ask` 提问**：默认只问 **1 个**最关键的；只有几件事彼此独立、都卡住下一步时才一次给 2–3 个，**永远不超过 3 个**。
- 每题 2–4 个具体选项，第一个是推荐值；选项具体到能直接开工（「8 页 A4 PDF」而不是「长一点」）。
- 从清单里挑真正缺的：目标与完成标准 / 交付物形态 / 受众与语气 / 范围与明确不要 / 约束 / 参考样例 / 验收方式。
- **最多两轮**；第二轮之后必须交需求卡，宁可带着写明的假设开工。
- 澄清阶段**只读不写**；「别问了直接做」立刻停；小任务最多问一个点。

---

## 界面

输入框右侧的胶囊按钮，四种状态：

| 状态 | 样子 | 点它 |
| --- | --- | --- |
| 关 | 「澄清」灰点 | 打开 |
| 开 | 「澄清中」品牌色点 | 关闭 |
| 有待答问题 | 「先答 3 个问题」实心高亮 | 展开面板 |
| 已确认 | 「已确认」+「卡」 | 关闭 / 看卡片 |

命令也能用：`/clarify`、`/clarify on|off|status`。

---

## 安装

```powershell
# 1) 完全退出 DeepSeek Harness
# 2) 在本目录里：
.\install.ps1 -DryRun     # 只看会做什么
.\install.ps1             # 拷到 E:\dsh-env\plugins-local\dsh-clarify，
                          # pnpm add link:…，并把名字补进 dsh.profile.bundles
# 3) 重新打开 DeepSeek Harness，输入框右侧出现「澄清」
```

| 参数 | 作用 |
| --- | --- |
| `-Profile <路径>` | 指定 profile（默认按 `%USERPROFILE%\.dsh\profiles\desktop` → `…\web` → `E:\dsh\profiles\desktop` 探测） |
| `-Target <路径>` | 拷到哪里（默认 `E:\dsh-env\plugins-local\dsh-clarify`） |
| `-DryRun` | 只打印，不改文件、不跑 pnpm |
| `-Uninstall` | 从 profile 移除（保留源码目录） |

升级已有安装：重跑 `.\install.ps1`（会覆盖 `lib/`），然后重启应用。

自检：

```powershell
Invoke-RestMethod http://127.0.0.1:<端口>/api/clarify/health
# { ok: true, version: "0.4.0", ..., pending: 0, cards: 0, interviews: 0,
#   surfaces: { section: true, tools: true, routes: 8, commands: true, error: "" } }
```

---

## 配置

profile 的 `cordis.patch.yml`，行 id `clarify`：

```yaml
- id: clarify
  config:
    sectionOrder: 3050          # 提示词段落顺序
    storePath: ''               # 默认 $DSH_HOME/clarify/state.json
    guidance: true              # false = 只保留开关和工具，不注入提示词
    defaultEnabled: false       # true = 新会话默认开着
    interviewTimeoutMs: 1200000 # 面板 20 分钟没人答就超时，模型改在聊天里问
    cardFile: true              # false = 不把需求卡写成 workspace 里的 .md
    cardFileDir: ''             # 默认 <会话 cwd>/.dsh/clarify
    interviewMode: full         # quick = 默认只问 1 题；full = 完整访谈
```

整行关掉：`- id: clarify` + `disabled: true`。

---

## 状态与接口

状态文件 `$DSH_HOME/clarify/state.json`（本机 `E:\dsh\clarify\state.json`），一个会话一行：`enabled` / `brief` / `approvedAt`。原子写、最多 300 行。

同目录的 `cards.json` 是最近 8 张批准过的卡（见「记忆复查」）；`metrics.json` 是访谈指标（见「指标」）；workspace 里的 `.dsh/clarify/*.md` 是同一张卡给人读的副本（见「需求卡落盘」）。

面板用到的路由（客户端全部用文档相对路径）：

| 路由 | 作用 |
| --- | --- |
| `GET /api/clarify/pending?session=` | 面板每 2–9 秒轮询一次；**同时是「客户端在线」的心跳** |
| `POST /api/clarify/answer` | 提交某次提问的全部答案（每题 `{id, selected, custom}`） |
| `POST /api/clarify/cancel` | `dismissed` 交还这一轮 / `skipped` 按推荐开工 |
| `GET /api/clarify/state` | 开关状态与需求卡（胶囊按钮用，不算心跳） |
| `POST /api/clarify/toggle` `…/clear` | 开关、清卡 |
| `GET /api/clarify/waiting` | 哪些会话正卡在提问上（侧栏 `⏳` 用；不参与心跳） |
| `GET /api/clarify/health` | 四个面是否都挂上了、当前待答数、卡片数、访谈记录数 |

---

## 安全边界

所有路由都过两道栅栏（和全局待办插件一致）：

1. 宿主自己的连接围栏 `connection.requestRejection`：校验 Host/Origin 与浏览器会话 cookie，认证通过才放行；
2. 没有该服务时退回**严格本机**规则：非 loopback 一律 403。

**本机脚本例外**：没有 cookie、没有 Origin、从 127.0.0.1 发出的请求（`curl`、本地诊断脚本）按 loopback 规则放行——这是为了让自检和宿主的本地工具照常工作，代价是**同机进程受信任**。局域网/公网场景下，没有有效浏览器 cookie 的请求会被 401/403 挡在处理器之外。

## 已知限制

- **约束是提示词级的，不是沙箱。** 「澄清阶段只读不写」靠指令和确认门，插件不拦 `write`/`bash`。
- **本机进程受信任。** 见「安全边界」：同机的 curl 级别调用仍能读卡片、答问题；插件防的是跨站与局域网匿名访问。
- **面板靠心跳判定在线。** 面板 15 秒内没轮询，宿主就认为没有面板，退回内置问答（一次一题）。所以面板只由 `conversation.input.dock` 里的组件启动轮询——胶囊按钮只读一次状态，绝不冒充心跳。
- **超时会退回聊天。** 面板 20 分钟没人答（`interviewTimeoutMs`），工具返回 `timeout`，模型会把问题整理成一段话贴到回复里。
- **子 Agent 里不能确认**，会拿到 `no_client`，不会卡死。
- **状态按 session id 记**，fork/重命名成新 id 后不带模式；重新点一下开关即可。
- **「已开工」只在当前进程内记。** 它来自 `session/event` 的写文件类工具调用，重启后从头判断；`bash` 不算开工（它可能只是 `ls`），所以用 bash 生成的交付物不会触发 goal 过滤。
- **指标是本地文件，不是遥测。** 记录写在 `$DSH_HOME/clarify/metrics.json`，最多 500 条；`invalid`/`busy` 这类没有真实访谈的尝试不记录。
- **提示词是中文写的**，英文会话能跑，但模型会用中文问。

---

## 开发

```
lib/protocol.js   两段提示词（访谈 / 已确认卡片的锚）+ 最近卡片摘要 + 卡片清洗
lib/interview.js  待答队列：一题一组、答案路由回填、超时/取消/跳过/卸载都有出路
lib/state.js      按会话的状态文件（原子写、串行写、淘汰）
lib/preferences.js 批准过的需求卡存档（cards.json，最近 8 张，串行写）
lib/card-file.js  需求卡落盘（<cwd>/.dsh/clarify/*.md，slug、去重名、原子写）
lib/metrics.js    访谈指标（metrics.json，最多 500 条，summary/record）
lib/work-tracker.js 从 session/event 记住哪些会话已经用过写文件类工具
lib/tools.js      clarify_ask（访谈）+ clarify_brief（确认门），无面板时逐题回退
lib/routes.js     /api/clarify/*（pending 兼作心跳）
lib/index.js      接线：systemPrompt / tools / webServer / commands / session events
lib/client.js     胶囊按钮 + 访谈面板（共用一份轮询）
tools/stats.mjs   访谈指标 CLI（--file / --json）
test/             144 个测试，含假 Cordis 上下文、真实的待答队列、连接围栏
```

```powershell
npm run verify    # node --check + 全部测试
```

测试用 `node --test --test-isolation=none`（单进程，不 spawn 子进程），受限沙箱里也能跑。

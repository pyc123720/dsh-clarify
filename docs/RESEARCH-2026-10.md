# 需求澄清：别人做到了什么程度

> 为 `dsh-clarify`（澄清模式）做的横向调研。时间窗：2023–2026；视角：**在 AI 动手前把需求问清楚**这件事，学术界、工业界、以及批评者各自走到了哪一步。
>
> 结论先行：方向被反复验证是对的，但**「问什么、什么时候问、问完留下什么」**这三件事，业界已经比我们做得更细。我们唯一明显领先的是**交互形态**（会话内、每题独立作答、零文档）。

**目录**：[结论](#0-四条结论) · [学术](#1-学术三条路线一张证据表) · [工业界](#2-工业界五条路线) · [机制原语](#26-底层原语别人怎么实现停下来等回答) · [批评](#3-批评这套东西哪里会翻车) · [我们的位置](#4-我们的位置) · [值得抄的八件事](#5-值得抄的八件事按-roi-排) · [建议](#6-建议先做哪三件) · [参考](#7-参考)


---

## 0. 四条结论

1. **「先澄清」有效，效果可量化。** ClarifyGPT 把 GPT-4 在 MBPP-sanitized 上的 pass@1 从 70.96% 提到 80.80%；Ambig-SWE 里交互带来的相对提升最高 74%；CONTRA 用「只问会改变程序行为的问题」在 ClarifyCodeBench 上比最强 baseline 高 13.88pp。方向不用怀疑。
2. **模型不会自觉问，也不擅长判断该不该问。** 「Knowing but Not Showing」发现模型能判出歧义却照样直接答；Ambig-SWE 发现模型分不清清楚与含糊；Ask Early 的 300 场会话里 52% 是问太多。**人工开关 + 硬规则**不是保守，是对症。
3. **但要克制，而且「问完留下什么」比「问多少」更重要。** Ask Less 证明限 1–3 问可把注意力成本降 36–73% 而保住 86–94% 收益；Spec Kit 的教训是工件一多就变成审 Markdown。我们的「一张卡、不落文件」在正确的一侧，但缺一个沉淀出口。
4. **我们领先的是交互形态，落后的是问题质量与沉淀。** 面板式逐题作答、跳过、默认值、无面板回退——这些工业界都还是纯对话；但「只问会改变行为的」「记住你上次怎么答的」「把卡留下来」这三件，学界已经有更成熟的做法。

> **如果只读三篇**：Ambig-SWE（把问题定义、最强动机数字、模型的弱点一次讲清）、ClarifyGPT（奠基 + 可复现的 pass@1）、Ask Less, Ask Better（提问的代价，目前唯一给出「少问多少」区间的文献）。


## 1. 学术：三条路线、一张证据表

### 1.1 三条路线

研究界其实在解决三个不同的问题，混在一起谈会得出矛盾结论：

| 路线 | 做法 | 代表 |
| --- | --- | --- |
| **A. 问用户**（交互式澄清） | 检测歧义 → 生成问题 → 用回答改写需求/代码 | ClarifyGPT、HumanEvalComm、ClarifyCoder、ClarQ-LLM、Ambig-SWE、CONTRA、REVOIR |
| **B. 自己补**（无交互改写） | 推断歧义并自动改写题面，不打扰用户 | SpecFix |
| **C. 不补、但把后果说清楚** | 把"欠指定导致的越界"变成可度量的行为类别 | UnderSpecBench、FDE-Gym |

本插件属于 A，而且是 A 里最保守的一种：**人来开关 + 一次问完 + 卡片确认**。

### 1.2 证据表（只列有数字的）

| 工作 | 年份/出处 | 关键数字 | 对我们的意义 |
| --- | --- | --- | --- |
| **ClarifyGPT** | FSE 2024 / arXiv [2310.10996](https://arxiv.org/abs/2310.10996) | MBPP-sanitized 上 GPT-4 pass@1 **70.96% → 80.80%**（10 名真人回答）；四基准均值 GPT-4 68.02→75.75、ChatGPT 58.55→67.22 | 「先判断再问」有效；歧义检测可以做在提问之前 |
| **HumanEvalComm** | TOSEM 2025 / arXiv [2406.00215](https://arxiv.org/abs/2406.00215) | 按不一致/歧义/不完整三类注入缺陷；提出 **Communication Rate / Good Question Rate** | 这两个指标可以直接拿来做我们的本地评测 |
| **ClarifyCoder** | 2025 预印本 / arXiv [2504.16331](https://arxiv.org/abs/2504.16331) | 微调后沟通率 **63%（+40pp）**、好问题率 **52%（+30pp）** | 「会不会问」能训；不训就只能靠提示词+工具强制 |
| **Ambig-SWE** | ICLR 2026 / arXiv [2502.13069](https://arxiv.org/abs/2502.13069) | 交互后相对非交互最高 **+74%**；但模型**分不清**说得清与说不清 | 人工开关规避了模型最大弱点；也说明"自动判断该不该问"很难 |
| **ClarQ-LLM** | 2024 预印本 / arXiv [2409.06097](https://arxiv.org/abs/2409.06097) | 中英双语、31 类任务；最强 seeker 成功率 **60.05%** | 「问对」本身是难题，别指望一次问全 |
| **Ask Early, Ask Late, Ask Right** | 2026 预印本 / arXiv [2605.07937](https://arxiv.org/abs/2605.07937) | goal 类澄清在执行 **10%** 后几乎归零；input 类能撑到 **50%**；拖到中段之后**不如不问**；300 场会话中 **52% 问太多** | 直接支持「开工前问」；goal 类问题开工后别再问 |
| **Ask Less, Ask Better** | 2026 预印本 / arXiv [2610.24411](https://arxiv.org/abs/2610.24411) | 限 **1–3 问**：注意力成本降 **36–73%**，仍保住 **86–94%** 的任务收益；对照"用户之前的回答"复查每个问题，再省 **13%** 成本且收益几乎不降 | 我们的「默认 1 个、最多 3 个」被数据支持；「偏好记忆」不只是体验，是省成本 |
| **CONTRA** | 2026 预印本 / arXiv [2610.01769](https://arxiv.org/abs/2610.01769) | 只保留「会改变程序行为」的问题；ClarifyCodeBench 上四个 coding agent 全部 F1 最高，宏均 **+13.88pp**，优于 Claude Code / OpenHands 原生 harness | 最值得抄的一条：**问之前先判断"这个答案会改变做法吗"** |
| **Knowing but Not Showing** | 2026 预印本 / arXiv [2605.25284](https://arxiv.org/abs/2605.25284) | 模型能认出歧义，但默认直接作答；检索到的上下文越多，越不问 | 证明「靠模型自觉」不成立，必须有开关或硬规则 |
| **SpecFix** | 2025 预印本 / arXiv [2505.07270](https://arxiv.org/abs/2505.07270) | 不打扰用户，自动改写 **43.58%** 的题面，被改题 pass@1 **+30.9%**，全基准 **+4.09%** | 「自己补」的上界参照：改写也能赚，但**改写的内容需要人确认**——正是需求卡做的事 |
| **UnderSpecBench** | 2026 预印本 / arXiv [2607.02294](https://arxiv.org/abs/2607.02294) | 2,208 个欠指定变体；**55.8–67.8%** 的 run 至少越界一次 | 把「问了」单列为一种结果类别的做法，可以借来做评测 |
| **SWE-Clar** | 2026 预印本 / arXiv [2610.31854](https://arxiv.org/abs/2610.31854) | 100 个真实 Upwork 订单（≥$4,000）；最强模型通过率 **67%**；澄清质量与实现质量**分开测** | 「澄清分」与「实现分」解耦的评测设计，值得抄 |
| **CloudArchitectBuddy** | 2025 预印本 / arXiv [2505.20701](https://arxiv.org/abs/2505.20701) | 结构化表单 vs 纯对话：设计质量相当，但**可用性更高、更擅长发现缺失需求**；用户仍要求保留自由对话 | 我们「面板 + 自由输入」的组合被实证支持 |
| **Zou et al.（前置）** | CIKM 2020 / arXiv [2008.00279](https://arxiv.org/abs/2008.00279) | 用户愿意答 **11–21 个**问题，再多会烦；**12–17%** 的回答与目标产品描述相反 | 「问多少会疲劳」的经验锚点 |

> 注：2026 年这批多为预印本，数字为作者报告；引用时标注 arXiv 与状态。

### 1.3 基准：该用什么尺子

| 基准 | 测什么 | 指标 |
| --- | --- | --- |
| HumanEvalComm | 该问时有没有问 | Communication Rate、Good Question Rate |
| ClarifyCodeBench（[2607.00711](https://arxiv.org/abs/2607.00711)） | 代码领域的澄清能力 | **Turn-discounted Key Question Rate**、**Optimal Round Adherence**（惩罚低效提问） |
| ClarEval（[2603.00187](https://arxiv.org/abs/2603.00187)） | 协作商数 | Average Turns to Clarify、Key Question Coverage |
| SWE-Clar | 真实订单 | 澄清理解题（512 道）+ 实现通过率，两次独立 run |
| Ambig-SWE | 欠指定的 SWE 任务 | 识别率、提问质量、交互后提升 |
| UnderSpecBench | 越界行为 | Safe Success / Wrong Target / OverScope；clarification 单列 |

**注意一个常见误引**：τ-bench / τ²-bench **不是**「信息缺失需要问」的基准——它们的用户模拟器基本会主动给全信息，考的是规则遵循与工具协调。真正把「缺信息」做成实验变量的是 Ambig-SWE、SWE-Clar、UnderSpecBench、ClarifyCodeBench、HumanEvalComm。

### 1.4 四个共识 + 三个反直觉

**共识**
1. **歧义要先检测**，而不是对每个请求都启动访谈（ClarifyGPT、CONTRA）。
2. **问题质量 > 数量**（Good Question Rate；Ask Less 的「同样问题数，成本差 2 倍」）。
3. **时机是变量**：goal 类信息过期极快（Ask Early）。
4. **结构化输入更好用**，但不能取代自由表达（CloudArchitectBuddy）。

**反直觉**
1. **识别 ≠ 行动**：模型能判歧义，却仍然直接答（Knowing but Not Showing）。
2. **「多问」不是银弹**：用户本身说不清时，提示 agent 多问并不能补救（Not Every User Says It All，[2610.24294](https://arxiv.org/abs/2610.24294)）。
3. **只问 1–3 个反而更划算**：注意力成本骤降而收益几乎不掉（Ask Less）。

### 1.5 一个真实空白

没有论文直接测「澄清让返工次数下降多少」。现有证据都是 pass@1、成功率、轮次、注意力成本。**「返工率」是本插件最该自己攒的数据**，也是别人没占的坑。

## 2. 工业界：五条路线

### 2.1 GitHub Spec Kit —— 把澄清做成一个独立命令

官方文档（[Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html)）给的流水线：

```
/speckit.constitution → /speckit.specify → /speckit.clarify → /speckit.plan
→ /speckit.checklist → /speckit.tasks → /speckit.analyze → /speckit.implement → /speckit.converge
```

- `/speckit.clarify`：**最多五个针对性问题**，把答案**编码回 `spec.md`**；可以带一个 focus 参数只问某个方面（「Focus on the task card behavior」）。
- 还有三道质量门：`checklist`（「需求的单元测试」）、`analyze`（跨工件一致性检查，只读）、`converge`（实现后比对缺口，只追加任务）。
- 关键设计：**澄清是可选的质量门**，但产物必须回写到文件。

### 2.2 AWS Kiro —— 澄清前置，然后一次生成三件套

- 标准 Feature Spec：`requirements.md`（EARS 记法）→ `design.md` → `tasks.md`，**每步一道审批门**。
- **Quick Spec**（[文档](https://kiro.dev/docs/specs/quick-spec/)）：**先一次性把澄清问题问完**（scope、constraints、edge cases），然后无门生成三件套。官方原话：「The clarifying questions are the key interaction point.」
- 这其实就是我们做的事：**把审阅换成一次问清**。区别是它产出三个文件，我们产出一张卡。

### 2.3 Tessl 与 ChatPRD —— 两种「文档优先」

- **Tessl**（[spec-as-source](https://docs.tessl.io/introduction-to-tessl/concepts)，beta）：spec 是主文件，代码标 `// GENERATED FROM SPEC - DO NOT EDIT`。
- **ChatPRD**（[chatprd.ai](https://www.chatprd.ai/)）：条件式追问——「需要时才问」，成稿后有 **Review assumptions**（查缺口、风险假设、漏掉的边界）和文内 **Open questions** 区块，可导出到 Notion/Confluence。它是「PRD 生成器」里把澄清当例行步骤的代表。

### 2.4 Claude Code / Cursor / Antigravity —— 计划门 + 自选提问

- **Claude Code**：plan mode 只读研究、写计划、等人批准（三选一），批准后才动代码——**计划门是硬的，提问是软的**（[文档](https://code.claude.com/docs/en/permission-modes)）。澄清靠内置 `AskUserQuestion`，由模型自选时机，不是固定阶段。
- **Cursor**：Plan Mode 五步，**第一步就是「问澄清问题」**，然后研究代码、出计划、你在文件里改、点 build 才执行（[文档](https://cursor.com/docs/agent/plan-mode)）。
- **Google Antigravity**：这块最值得看，因为它有两个入口——
  - `/plan` 的第二步明确叫 **「Clarification and interviewing」**：需求不清或有多方案时，发起聚焦访谈（交互式问题卡 + 结构化选项），再产出 Implementation Plan，你点 Proceed 才开工（[文档](https://antigravity.google/docs/plan/)）。
  - `/grill-me` 是**独立的访谈命令**：动手前逐题访谈，「asks one question at a time and recommends an answer for each」，能靠读代码回答的就不问人，每题可选项/自填/跳过（[文档](https://antigravity.google/docs/commands/grill-me/)）。

> `/grill-me` 是目前工业界和我们形态最接近的东西。差别：它**一次一题、推荐答案**；我们**一次 1–3 题、每题独立输入框**。前者干扰更多、后者一次问完——按 Ask Less 与打断研究，我们的批量形态更省注意力，但逐题更适合「答案会影响下一问」的链式需求。

### 2.5 对比表

| 工具 | 澄清方式 | 产出 | 强制性 |
| --- | --- | --- | --- |
| **Spec Kit** | `/speckit.clarify`：≤5 个靶向问题，答案写回 `spec.md`，可反复、可带 focus | `spec.md` / `plan.md` / `tasks.md` / checklist | **可选质量门**（只有 specify 是硬前置；implement 对 checklist 是软门） |
| **Kiro 标准 Spec** | requirements 阶段人工 review + 对话迭代；EARS（WHEN…THE SYSTEM SHALL…） | `.kiro/specs/` 三件套 | **阶段门强制**（逐份确认） |
| **Kiro Quick Spec** | 开工前一次性问清 scope/约束/边界 | 同三件套，无中间门 | **零审批门** |
| **Claude Code** | plan mode 内用 `AskUserQuestion` 自选提问 | 对话内计划 | 计划门硬，提问软 |
| **Cursor** | Plan Mode 第一步即澄清提问 | 计划文件（可存 workspace） | 点 build 才执行 |
| **Antigravity** | `/plan` 内置澄清访谈；`/grill-me` 逐题访谈 + 推荐答案 | Implementation Plan / Walkthrough | `/plan` 需 Proceed 批准；`/grill-me` 可选 |
| **ChatPRD** | 条件式追问 + Review assumptions + Open questions | PRD 文档/模板/导出 | 无门，建议式 |
| **dsh-clarify** | 面板：1–3 题、每题选项 + 输入框、默认选中、跳过 | 一张需求卡（会话状态里） | 提示词级 + 确认门 |

### 2.5.1 三条观察

1. **只有两家把「澄清」做成显式的一等命令**：Spec Kit 的 `/clarify`（唯一把答案结构化写回 `spec.md`）和 Antigravity 的 `/grill-me`（唯一把访谈做成独立命令、逐题给推荐答案）。
2. **主流是把澄清塞进「阶段门」**：Kiro 靠 requirements 的人工确认，Cursor/Claude 靠 plan mode 的对话提问——**门是硬的，提问是软的**。
3. **反向取舍已经出现**：Kiro Quick Spec 用「前置问清」换掉全部阶段门，Spec Kit 用「可选门 + checklist」换掉强制流程。两种都说明：**纯强制澄清还不是默认答案**。


### 2.6 底层原语：别人怎么实现「停下来等回答」

这一层决定了「面板关掉/页面刷新/超时」时会发生什么，比产品形态更值得抄。

| 原语 | 挂起与恢复 | 已知的坑 |
| --- | --- | --- |
| **LangGraph `interrupt()`** | 节点内抛异常 → checkpointer 存状态 → `Command(resume=...)` 恢复 | 恢复时**节点从头重跑**（interrupt 前的副作用必须幂等）；多个 interrupt 按**索引**匹配；默认**无限等待**，没有内建超时（[文档](https://docs.langchain.com/oss/python/langgraph/interrupts)） |
| **Claude Code `AskUserQuestion`** | 作为工具经 `canUseTool` 回调挂起，返回 `answers` | 回调可无限 pending；**子 agent 不可用**；一次 1–4 题、每题 2–4 选项（[文档](https://code.claude.com/docs/en/agent-sdk/user-input)） |
| **OpenAI Agents SDK** | `needs_approval` → `interruptions` → 批准/拒绝后恢复 | **只有审批，没有自由问答原语**；未解决项会再次挂起（[文档](https://openai.github.io/openai-agents-python/human_in_the_loop/)） |
| **AutoGen** | `UserProxyAgent(input_func)` 阻塞团队 | 官方明说阻塞式**不能保存/恢复**，只适合短交互（[文档](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html)） |
| **MCP elicitation** | server→client `elicitation/create`，三态 accept/decline/cancel | schema 只支持**扁平原始类型**；禁止用它收集密钥（[规范](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)） |

我们在 dsh-clarify 里选的是第六种：**宿主端待答队列 + HTTP 回填**。好处是刷新不丢、可超时、可跳过、可在无面板环境降级；代价是自己要维护「谁在线、什么时候过期」（上一轮修的看门狗就是这个代价）。


---

## 3. 批评：这套东西哪里会翻车

### 3.1 「瀑布流回潮」

marmelab 的 [Spec-Driven Development: The Waterfall Strikes Back](https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html) 给了具体案例：Spec Kit 为一个「显示当前日期」的小功能生成了 **8 个文件、1300 行**。作者列了七宗罪：上下文盲区、Markdown 泛滥、系统性官僚、假敏捷、双重代码评审（规格里已经有代码，要审两遍）、虚假安全感（agent 不按规格执行）、大代码库上收益递减。

### 3.2 小任务被压垮

Böckeler 的实测更具体：让 Kiro 修一个小 bug，**requirements 变成 4 个 user story、16 条验收标准**；Spec Kit 的 3–5 点故事产出大量重复 Markdown。她的原话大意是：**「我宁愿审代码，也不想审这些 Markdown。」**

### 3.3 过度提问

Ask Early 的 300 场会话里 **52% 是问太多**；而且没有任何前沿模型落在「最优提问窗口」里。对我们的直接启示：默认只问 1 个、两轮上限、跳过出口，这些都是对的；**不要**因为「澄清有效」就默认狂问。

### 3.4 敷衍作答（satisficing）

CHI 2019 的研究（[doi](https://doi.org/10.1145/3290605.3300316)）用 satisficing 解释低质量作答：问题越多、越像流程，人越倾向挑第一个能过的选项。Claude Code 官方文档也自认「到第十次批准你就不看了」。**默认值既是效率，也是敷衍的入口**——所以我们的卡上要回显「用了哪个默认」，而不是让默认值隐身。

### 3.5 打断是有代价的

Mark、Gudith & Klocke 的 CHI 2008 研究（[doi](https://dl.acm.org/doi/10.1145/1357054.1357072)）发现：被打断的人会加速补偿，但压力、挫败感、时间压力都上升。设计含义很直接：**能批量别逐条弹，能异步别同步阻塞**——这正是我们「一次问完」而不是「一问一停」的依据。

### 3.6 是该「总能问」还是「只在必要时问」

CLAM（[arXiv 2212.07769](https://arxiv.org/abs/2212.07769)）用歧义分类器做**选择性澄清**，并指出强制澄清在无歧义问题上会被惩罚、甚至把对话带偏；AwN（[arXiv 2409.00557](https://arxiv.org/abs/2409.00557)）发现提问能换准确率，但步数与冗余问题也上升（冗余率 0.16–1.44）。结论与 CONTRA 一致：**收益取决于命中率，不取决于数量**。

### 3.7 一个反向平衡

marmelab 主张「自然语言开发」：不给规格，把复杂需求拆成小需求，用小步迭代替代大设计。它的证据是作者用 Claude Code 10 小时做出一个 3D 雕刻工具、没写任何 spec。这说明**澄清模式不是对所有任务都成立**——它适合「交付物明确、返工贵」的任务，不适合探索型编码。

---

## 4. 我们的位置

### 4.1 比业界强的地方

- **交互形态**：每题独立选项 + 输入框、默认选中推荐值、一键全按推荐、跳过、超时降级、无面板环境自动退回内置问答——这套是我们在 DSH 里自己拼的，Spec Kit/Kiro 都是纯对话。CloudArchitectBuddy 的对照实验（结构化表单 vs 纯对话）显示：**质量相当、可用性更高、更容易发现缺失需求**，但用户仍要求保留自由输入——我们的「选项 + 输入框」正好是这两者的并集。
- **克制**：默认 1 个、最多 3 个、两轮上限——与 Ask Less 的「1–3 问」甜点一致（注意力成本降 36–73%，收益保住 86–94%）。
- **卡片锚定**：确认后的需求卡原样进每一轮提示词，长会话不漂移。Kiro/Spec Kit 靠文件，我们靠系统提示词，**不需要用户维护文档**。
- **零工件成本**：不产生 Markdown 文件，不引入双重评审。
- **可回退**：`/clarify off`、跳过、面板关闭三条路都能立刻回到「直接干活」。

### 4.2 比业界弱的地方

| 缺口 | 业界做法 | 我们的现状 | 后果 |
| --- | --- | --- | --- |
| 澄清内容不可复用 | Spec Kit 写回 `spec.md`；Kiro 生成三件套 | 卡只在会话状态里（`state.json`），不可 diff、不可交接 | 隔天回来或换会话，需求丢失 |
| 无质量门 | Spec Kit 有 checklist/analyze/converge | 只有一张卡，没有「需求是否完整」的检查 | 卡可能漏项而无人发现 |
| 无自动歧义预判 | ClarifyGPT 先判断再说 | 由人开关 | 用户忘记开 → 该问的没问 |
| 无问题质量度量 | HumanEvalComm 的 Communication Rate / Good Question Rate | 无任何指标 | 无法判断「问得好不好」 |
| 无时机策略 | Ask Early 的 goal/input 分级 | 永远是「开工前」，且「小修不重走流程」只是软规则 | 追问阶段可能问了过期的 goal 信息 |
| 无「行为改变」过滤 | CONTRA 只问会改变程序行为的问题，F1 +13.88pp | 只靠提示词里一句「只问会改变做法的」 | 可能问出「改了措辞但不改产出」的问题 |
| 无记忆复查 | Ask Less 对照历史回答复查每问，成本再降 13% | 每轮从零开始 | 同一个问题在不同会话里反复问 |

### 4.3 我们的提示词，逐条对照证据

| 提示词里的一条 | 对应证据 | 判定 |
| --- | --- | --- |
| 只问「答案会改变做法」的问题 | CONTRA 的行为改变过滤 | 方向对，但缺机制（靠模型自觉） |
| 默认 1 个、最多 3 个 | Ask Less 的 1–3 问甜点 | 有数据支持 |
| 最多两轮 | 用户 11–21 问才烦（Zou），我们更保守 | 合理偏严 |
| 「你定/随便」→ 立刻替他定，不再问 | Ask Less 的记忆复查 | 部分：我们只在本轮记住，跨轮不记 |
| 小修/追问不重走流程 | Ask Early 的时机曲线 | 对 |
| 先复述理解再提问 | 无直接实证，工程经验 | 保留 |
| 澄清阶段只读不写 | 无直接实证 | 保留（安全考虑） |
| 卡片原样进每一轮提示词 | Spec Kit 的 spec-first / Kiro 的 requirements.md | 对，但缺落盘 |


---

## 5. 值得抄的八件事（按 ROI 排）

1. **行为改变过滤**（CONTRA，[2610.01769](https://arxiv.org/abs/2610.01769)）
   问之前先自问：这个答案会改变我接下来写的东西吗？不会就别问。CONTRA 用「两个可能答案各生成一版程序、看行为是否不同」来判定，成本高但可靠；我们做轻量版即可——在 `clarify_ask` 的每题加一个 `impact` 字段（`changes-output` / `changes-wording` / `nice-to-know`），只有第一类允许进面板。成本：小（schema + 提示词），收益：直接提升 Good Question Rate。
2. **记忆复查**（Ask Less，[2610.24411](https://arxiv.org/abs/2610.24411)）
   每条问题先对照「你之前的回答/上次的卡」再决定问不问；论文里这一步让注意力成本再降 13%。这正是我们提过的「偏好档案」，现在有了数据支撑。成本：中，收益：**问得越用越少**。
3. **卡落文件**（Spec Kit 的 spec-first 最小版）
   确认后把卡写到工作区（如 `./.dsh/需求卡-<slug>.md`），可 diff、可交接、下次会话可读。成本：中（定路径与覆盖策略），收益：补上最大的结构性缺口。
4. **卡内验收清单**（Spec Kit 的 checklist 轻量版）
   卡里加 3–5 条可勾选验收项，开工后逐条自查。成本：小（提示词），收益：补上「假安全感」。
5. **信息类型 + 时机规则**（Ask Early，[2605.07937](https://arxiv.org/abs/2605.07937)）
   每题标 `goal` / `input` / `constraint` / `context`；`goal` 只允许在第一次写文件前问，开工后只允许后三类。成本：小，收益：贴合「goal 信息 10% 后过期」的实证。
6. **快慢两档**（Kiro 的 Quick Spec vs Feature Spec）
   现在只有「问/不问」；可显式成「快问 1 题」与「完整访谈（≤3 题 + 卡）」。成本：小。
7. **本地评测指标**（HumanEvalComm + ClarifyCodeBench）
   20 条含糊需求，离线量：该问的比例（Communication Rate）、问到点子上的比例（Good Question Rate），外加「轮次折扣的关键问题率」。成本：中（要标注），收益：把「问得好不好」变成数字。
8. **focus 参数**（Spec Kit 的 clarify focus）
   `clarify_ask` 支持「这轮只问交付物」。成本：很小。

## 6. 建议：先做哪三件

1. **行为改变过滤**（第 1 条）——最小改动、直接提升问题质量，且完全在我们现有 `clarify_ask` schema 里做。
2. **记忆复查**（第 2 条）——把「上次的卡/上次的答案」变成面板的预填值。这是唯一能让提问量随使用下降的机制。
3. **卡落文件**（第 3 条）——补上结构性缺口，让澄清结果可交接、可 diff、跨会话可用。

第 4、5 条（验收清单、时机规则）建议紧随其后，都是一两处提示词改动。第 6、7 条（两档、评测）放下一轮，因为需要先有稳定用法与数据。

### 6.1 怎么验证它真的有用

学界都测 pass@1 / 成功率 / 注意力成本，没人测「返工」——这恰好是我们能自己攒的数据。一个两周能跑完的小实验：

1. **任务集**：挑 20 个真实需求（10 个你原本就会返工一次的，10 个一次过的），记下原始一句话描述。
2. **两组**：A 组关掉澄清直接做；B 组开澄清。同一批任务、同一模型、交替顺序跑，避免疲劳偏差。
3. **指标**（每个任务记一行）：
   - 返工轮次：你说「不对/改成」的次数（对应 DORA 的 deployment rework rate 思路，[dora.dev](https://dora.dev/guides/dora-metrics/)）
   - 首次通过：你 5 分钟内说「可以」= 1
   - 面板耗时：从提问出现到你提交的秒数
   - 成本：该轮 token（DSH 会话日志里有）
   - 主观负担：每次任务后 1–5 分打个「这次被问得烦不烦」（NASA-TLX 的极简版）
4. **判定**：返工率下降 ≥30% 且面板耗时中位数 <60 秒 → 值得默认开；否则只在你预感会返工时开。

这个实验不需要发论文，但两周后你会知道「值不值得默认开」，而不是靠感觉。

## 7. 参考

**论文**

- ClarifyGPT: https://arxiv.org/abs/2310.10996
- HumanEvalComm (TOSEM 2025): https://arxiv.org/abs/2406.00215
- ClarifyCoder: https://arxiv.org/abs/2504.16331
- Ambig-SWE (ICLR 2026): https://arxiv.org/abs/2502.13069
- ClarQ-LLM: https://arxiv.org/abs/2409.06097
- Ask Early, Ask Late, Ask Right: https://arxiv.org/abs/2605.07937
- Ask Less, Ask Better: https://arxiv.org/abs/2610.24411
- CONTRA: https://arxiv.org/abs/2610.01769
- Knowing but Not Showing: https://arxiv.org/abs/2605.25284
- SpecFix: https://arxiv.org/abs/2505.07270
- UnderSpecBench: https://arxiv.org/abs/2607.02294
- SWE-Clar: https://arxiv.org/abs/2610.31854
- Not Every User Says It All: https://arxiv.org/abs/2610.24294
- ClarifyCodeBench: https://arxiv.org/abs/2607.00711
- CloudArchitectBuddy（表单 vs 对话）: https://arxiv.org/abs/2505.20701
- Ask-before-Plan (EMNLP 2024 Findings): https://aclanthology.org/2024.findings-emnlp.636.pdf

**工具与文档**

- Spec Kit 命令参考: https://github.github.com/spec-kit/reference/agentic-sdd.html
- Kiro Quick Spec: https://kiro.dev/docs/specs/quick-spec/
- Böckeler 的三工具对比: https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- marmelab 的 SDD 批评: https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html
- Claude Code plan mode: https://code.claude.com/docs/en/common-workflows
- Cursor Plan Mode: https://cursor.com/docs/agent/plan-mode
- Antigravity /plan: https://antigravity.google/docs/plan/
- Antigravity /grill-me: https://antigravity.google/docs/commands/grill-me/
- ChatPRD: https://www.chatprd.ai/

**局限**

- 未做用户实验；所有数字来自论文/官方文档的自报结果。
- 2026 年的工作仍在快速迭代（例如 Ask Early 是 2026-05 的预印本），引用时以原文为准。
- 未覆盖中文社区（知乎/公众号）的实践，那里可能有更多「先访谈再动手」的提示词工程经验。
- OpenAI Codex 的官方文档在本机网络下返回 403，**未核实**，因此对比表里留空。
- 原语部分的「坑」来自官方文档与规范（2026-10 读取），产品迭代很快，具体限制以当时文档为准。

---

## 附录：0.4.0 落地情况（2026-10-28）

本报告的建议已经全部落进 dsh-clarify 0.4.0（144 个测试）：

| 报告里的建议 | 状态 | 落点 |
| --- | --- | --- |
| 1. 行为改变过滤（CONTRA） | ✅ 0.3.0 | `clarify_ask` 每题 `impact`，非 `changes-output` 丢弃并在 note 说明 |
| 2. 记忆复查（Ask Less） | ✅ 0.3.0 | `cards.json` 存最近 8 张卡；澄清段落注入最近 3 张摘要 |
| 3. 卡落文件（Spec Kit） | ✅ 0.3.0 | `<cwd>/.dsh/clarify/card-YYYYMMDD-HHMM-<标题>.md`，`cardPath` 回传 |
| 4. 卡内验收清单 | ✅ 0.4.0 | `clarify_brief` 的 `checklist`，确认页 / 锚 / 落盘同源 |
| 5. 信息类型 + 时机规则 | ✅ 0.4.0 | 每题 `kind`（goal/input/constraint/context）+ `work-tracker`：写过文件后丢弃 goal 题 |
| 6. 快慢两档（Kiro Quick Spec） | ✅ 0.4.0 | `clarify_ask.mode`（quick 只问 1 题）+ 配置 `interviewMode` |
| 7. 本地评测指标 | ✅ 0.4.0 | `metrics.json` + `tools/stats.mjs`（提问数 / 丢弃率 / 作答率 / 耗时） |
| 8. focus 参数（Spec Kit） | ✅ 0.4.0 | `clarify_ask.focus`，面板显示「只问：…」 |

**仍缺的一件**：`6.1` 里的返工率 A/B。`metrics.json` 已经能提供提问侧的数据，但「返工次数」要你在真实任务里跑两周才有结论——这是唯一只能靠使用、不能靠实现补上的东西。

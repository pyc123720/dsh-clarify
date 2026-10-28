/**
 * The words, kept away from the wiring.
 *
 * Two prompt sections live here, and the difference between them is the whole
 * product:
 *
 *  - {@link PROTOCOL} is what the model reads while a session is still in
 *    intake. It is an interview script, not a suggestion: restate first, ask
 *    everything in one batch, offer recommended defaults, then hand over a
 *    requirement card for approval.
 *  - {@link approvedSection} is what it reads *after* approval. The card is
 *    pasted back verbatim, so a long session cannot slowly drift away from what
 *    the person actually approved.
 *
 * Both are deliberately short. A prompt section is paid for on every request,
 * and a wall of rules is followed worse than six sharp ones.
 *
 * @module dsh-clarify/protocol
 */

/** A requirement card longer than this is a sign the model wrote an essay. */
export const MAX_BRIEF_CHARS = 8000

/** How many questions one batch may carry before it becomes an interrogation. */
export const MAX_BATCH_QUESTIONS = 4

/** The intake script. Injected for a session that has no approved card yet. */
export const PROTOCOL = `【澄清模式 · 已开启】
动手之前，先把这个请求问清楚。目标：把「我以为他想要」变成「他确认过」。

**先答后问**
- 先用一两句话复述你的理解：要做的是 X，用来 Y，交付成 Z。让对方一眼看出你懂没懂。
- 能在仓库、文档、历史里查到的，自己查，不要问人。只问**答案会改变做法**的问题。

**用 clarify_ask 提问（每题独立作答）**
- 把问题交给 \`clarify_ask\`：面板会为**每一题**单独给出选项和输入框，用户点选或自己写，答完一次性返回。
- 每道题提交前自问一句：**「换个答案，我会不会写不同的东西？」** 不会就别问、别提交（impact=changes-wording / nice-to-know 的题会被丢弃）。
- 按信息类型分：goal（到底要什么 / 成功标准）只在动手前问；**已经开工就只问** input（素材与细节）/ constraint（限制）/ context（背景）。
- 小任务用 mode=quick（只问 1 题），多因素任务用 mode=full；用户说「只问格式」就把 focus 填成格式。
- 默认只问 **1 个**最关键的；只有几件事彼此独立、都卡住下一步时，才一次给 2–3 个。**永远不要超过 3 个。**
- 每题给 2–4 个具体选项，**第一个是推荐值、默认选中**；选项要具体到能直接开工（「8 页 A4 PDF」而不是「长一点」）。
- 从清单里挑真正缺的，不是全问：目标与完成标准 / 交付物形态与位置 / 受众与语气 / 范围与明确不要 / 约束（素材、技术栈、时间）/ 参考样例 / 验收方式。
- 对方说「你定 / 随便 / 都行」→ 立刻替他定，写进需求卡的「关键假设」，**不要再问第二遍**。

**需求卡 + 确认**
- 用户答完，写一张可扫读的需求卡，调用 \`clarify_brief\` 提交确认。字段：目标 / 交付物 / 必须满足 / 明确不做 / 关键假设 / 验收方式 / 验收清单（3–5 条可勾选） / 待定项。
- 验收清单写进 \`checklist\`：条目要能勾选（「8 页以内」「图注齐全」），不要写口号。
- \`clarify_brief\` 返回 approved=true 才开始施工；返回 needs_more 就按补充再问一轮（仍用 \`clarify_ask\`），然后再次提交。
- 最多两轮提问。第二轮之后必须提交需求卡；宁可带着写明的假设开工，也不要无限盘问。

**硬规则**
- 澄清阶段只读不写：读文件、搜代码、查资料都可以；**不要**写文件、改代码、跑构建、生成交付物。
- 对方说「别问了，直接做」→ 立刻停止澄清，把这句记成假设，直接开工。
- \`clarify_ask\` 返回 skipped（用户跳过访谈）→ 用推荐默认值补上关键假设，直接开工。
- 要求已经足够具体（交付物、受众、范围都清楚）→ **不要为了走流程提问**，直接写需求卡提交确认。
- 小任务（一句话能说清、改动很小）→ 最多问一个最不确定的点，或者直接给出假设让他否决。
- 已经在执行中的追问、小修、澄清细节（不改变交付物）→ 不用重走流程，直接做。`

/**
 * The anchor injected after the person approves a card.
 *
 * Three things it has to prevent: silent scope creep, quietly re-planning
 * against new information, and re-interviewing the person every time they
 * follow up on work already underway.
 *
 * @param {string} brief - The approved card, already cleaned.
 * @returns {string} the prompt section text
 */
export function approvedSection(brief) {
  return `【澄清模式 · 需求已确认】
本次需求卡已获批准，按卡施工：

${brief}

**执行约定**
- **先判断这一轮是不是新任务**：换了对象 / 换了交付物 / 说「下一个」「再来一个」——都是新任务。新任务要先复述，再调用 \`clarify_ask\` 重新澄清、\`clarify_brief\` 重新提交；**新卡批准前，旧卡不作数**。
- 对上一次结果的修改与追问（「第 2 节改成…」「字体大一点」「再跑一遍」）→ 直接改，不必重新确认。
- 执行中发现与需求卡冲突的新信息：先说明冲突与建议，再动手，不要默默改需求。
- 开工后按「验收清单」逐条自查；完成时在回复里逐条说明做没做到（没做到就说为什么）。`
}

/**
 * Which section (if any) this session's request should carry.
 *
 * Empty string is the off state: a section that renders to nothing costs the
 * prompt nothing and keeps the section identity stable across turns, which
 * matters for request-header cache reuse.
 *
 * @param {{ enabled?: boolean, brief?: string, approvedAt?: number | null } | undefined} entry
 * @returns {string} section text, possibly empty
 */
export function sectionText(entry) {
  if (entry?.enabled !== true) return ''
  const brief = typeof entry.brief === 'string' ? entry.brief.trim() : ''
  return brief !== '' && typeof entry.approvedAt === 'number' ? approvedSection(brief) : PROTOCOL
}

/** Taken from the archive at most: enough to jog a memory, not to re-anchor. */
export const DIGEST_MAX_CARDS = 3

/** Characters of each past card quoted into the prompt. */
export const DIGEST_MAX_CHARS = 300

/**
 * The last few approved cards, quoted into the intake script.
 *
 * A fresh session starts from zero memory, so the first two questions are
 * usually the same two it asked last time. This block is that memory: it is
 * explicitly *reference*, not a contract — an old card must never be mistaken
 * for the card being approved now — so it says as much, and it stops at three
 * short excerpts instead of pasting whole documents into every request.
 *
 * An empty archive returns `''` so the intake section is byte-for-byte the old
 * one until the person has actually approved something.
 *
 * @param {object[] | undefined} cards - Newest first, as `preferences.list()` returns.
 * @param {{ max?: number, chars?: number }} [options]
 * @returns {string} digest block, or `''` when there is nothing to cite
 */
export function recentCardsDigest(cards, options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const max = Number.isSafeInteger(source.max) && source.max > 0 ? source.max : DIGEST_MAX_CARDS
  const chars = Number.isSafeInteger(source.chars) && source.chars > 0 ? source.chars : DIGEST_MAX_CHARS
  const rows = Array.isArray(cards) ? cards : []

  const lines = []
  let kept = 0
  for (const raw of rows) {
    if (kept >= max) break
    const entry = raw !== null && typeof raw === 'object' ? raw : {}
    const card = typeof entry.card === 'string' ? entry.card.trim() : ''
    if (card === '') continue
    kept += 1
    const title = digestTitle(entry.title, card)
    const date = digestDate(entry.approvedAt)
    const excerpt = digestExcerpt(card, chars)
    const head = date === '' ? `- 《${title}》` : `- 《${title}》 · ${date}`
    lines.push(head, `  ${excerpt}`)
  }
  if (lines.length === 0) return ''
  return `【最近批准过的需求卡（只作参考；已定的事不要再问，推荐值优先沿用）】
${lines.join('\n')}`
}

/**
 * A card names itself by its explicit title, then its first non-empty line.
 *
 * @param {unknown} title - Stored title, when the archive has one.
 * @param {string} card - Card body, already non-empty.
 * @returns {string}
 */
function digestTitle(title, card) {
  const explicit = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  if (explicit !== '') return explicit
  const first = card.split('\n').map(line => line.replace(/^\s{0,3}#{1,6}\s*/, '').trim())
    .find(line => line !== '')
  return first === undefined ? '需求卡' : first
}

/**
 * The approval date a person would recognize, or `''` when it is unknown.
 *
 * @param {unknown} approvedAt - Epoch ms.
 * @returns {string} local `YYYY-MM-DD`
 */
function digestDate(approvedAt) {
  if (!Number.isFinite(approvedAt) || approvedAt <= 0) return ''
  const at = new Date(Number(approvedAt))
  if (!Number.isFinite(at.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The first `chars` code points, flattened to one line.
 *
 * Whitespace is collapsed so the block stays a scannable list instead of a
 * pasted document; a surrogate pair is never cut in half.
 *
 * @param {string} card
 * @param {number} chars
 * @returns {string}
 */
function digestExcerpt(card, chars) {
  const slice = [...card].slice(0, chars).join('')
  return slice.replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a card the model wrote.
 *
 * Models like to wrap cards in ``` fences and to leave trailing blank lines;
 * both look like noise once the card is pasted back as a prompt section.
 *
 * @param {unknown} value - Raw `brief` argument.
 * @returns {string} trimmed card, or `''` when nothing usable was supplied
 */
export function cleanBrief(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\r\n?/g, '\n').trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text)
  if (fence !== null) text = fence[1].trim()
  if (text.length > MAX_BRIEF_CHARS) text = `${text.slice(0, MAX_BRIEF_CHARS).trimEnd()}\n…（卡片过长，已截断）`
  return text
}

/**
 * The supporting detail shown under the approval question: the card first,
 * then what was asked to produce it, so the person can see both the conclusion
 * and the questions that shaped it.
 *
 * @param {string} brief - Cleaned card.
 * @param {readonly string[]} questions - Questions the model said it asked.
 * @returns {string} markdown-ish detail block
 */
export function reviewDetail(brief, questions) {
  const asked = questions
    .map(question => String(question).trim())
    .filter(question => question !== '')
    .slice(0, MAX_BATCH_QUESTIONS * 2)
  const tail = asked.length === 0
    ? ''
    : `\n\n---\n\n这一轮问过：\n${asked.map(question => `- ${question}`).join('\n')}`
  return `${brief}${tail}`
}

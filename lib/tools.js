/**
 * The two model-facing surfaces: `clarify_ask` and `clarify_brief`.
 *
 * `clarify_ask` is the product. The prompt tells the model to gather what it is
 * missing; this tool gives each question its own option list and its own text
 * box, and returns every answer in one piece — which is the whole reason the
 * plugin owns a panel instead of borrowing the built-in one-question renderer.
 *
 * `clarify_brief` is the gate: the requirement card goes back to the person, and
 * only an explicit "确认开工" stores it and lets work start.
 *
 * Both prefer the plugin's panel and fall back to the built-in question channel
 * **one question at a time** (never one box for several questions). Every
 * outcome — answered, skipped, dismissed, timed out, no UI at all — comes back
 * with a named next move for the model, so no tool call can end in silence.
 *
 * @module dsh-clarify/tools
 */

import { resolveCardDir, writeCard } from './card-file.js'
import { MAX_BRIEF_CHARS, cleanBrief, reviewDetail } from './protocol.js'

/** Option labels shared by the review card and the answer mapping. */
export const APPROVE_LABEL = '确认开工'
export const ASK_MORE_LABEL = '还要再问'
export const SELF_EDIT_LABEL = '我自己改'

/** How many questions one call may carry before it stops being an interview. */
export const MAX_QUESTIONS = 5

/** How many options one question may offer. */
export const MAX_OPTIONS = 6

/**
 * Impact values a question may declare. Only the first earns a panel slot: an
 * answer that would not change what gets written is not worth a decision.
 */
export const IMPACT_VALUES = ['changes-output', 'changes-wording', 'nice-to-know']

/** The only impact value that survives {@link normalizeAsk}. */
export const IMPACT_CHANGES_OUTPUT = IMPACT_VALUES[0]

/** How many checklist items one requirement card may carry. */
export const MAX_CHECKLIST = 6

/** Information kinds a question may declare; `goal` is only valid before work starts. */
export const KIND_VALUES = ['goal', 'input', 'constraint', 'context']

/** Interview modes: `quick` asks one question, `full` asks the batch. */
export const MODE_VALUES = ['quick', 'full']

/** Tool names. Exported so the README, the client and tests cannot drift apart. */
export const CLARIFY_BRIEF = 'clarify_brief'
export const CLARIFY_ASK = 'clarify_ask'

/** Field defaults, named once so the filter, the schema and the tests agree. */
const KIND_GOAL = 'goal'
const KIND_DEFAULT = 'input'
const MODE_QUICK = 'quick'
const MODE_FULL = 'full'

const text = value => [{ type: 'text', text: value }]

/**
 * The card exactly as the person will see it: the model's brief plus any points
 * it declared still open and the acceptance checklist. One function so the
 * review card, the stored card and the model-facing echo can never disagree.
 *
 * @param {{ brief?: unknown, open?: unknown, checklist?: unknown }} args
 * @returns {string}
 */
export function cardFrom(args) {
  const brief = cleanBrief(args?.brief)
  const open = Array.isArray(args?.open)
    ? args.open.map(String).map(item => item.trim()).filter(item => item !== '')
    : []
  // A checklist without a card is not a card: the empty-brief refusal wins.
  const checklist = brief === '' || !Array.isArray(args?.checklist)
    ? []
    : args.checklist
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(item => item !== '')
      .slice(0, MAX_CHECKLIST)
  const pending = open.length === 0 ? '' : `\n\n**待定**\n${open.map(item => `- ${item}`).join('\n')}`
  const checks = checklist.length === 0
    ? ''
    : `\n\n**验收清单**\n${checklist.map(item => `- [ ] ${item}`).join('\n')}`
  return `${brief}${pending}${checks}`
}

/**
 * Whether one question's answer could change the artifact.
 *
 * A missing or empty `impact` means the documented default (`changes-output`);
 * any other declared value must match it — a question that only changes wording,
 * or is merely nice to know, does not deserve a slot in the panel.
 *
 * @param {unknown} value - Raw `impact` from the model.
 * @returns {boolean}
 */
function changesOutput(value) {
  if (value === undefined || value === null) return true
  const impact = String(value).trim().toLowerCase()
  return impact === '' || impact === IMPACT_CHANGES_OUTPUT
}

/**
 * The information kind a question declared.
 *
 * @param {unknown} value - Raw `kind` from the model.
 * @returns {string} one of {@link KIND_VALUES}; `input` when absent or unknown
 */
function questionKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return KIND_VALUES.includes(kind) ? kind : KIND_DEFAULT
}

/**
 * The interview mode for this call: the argument when valid, otherwise the
 * caller's default.
 *
 * @param {unknown} value - Raw `mode` argument.
 * @param {unknown} defaultMode - Dependency-injected default.
 * @returns {string} `quick` or `full`
 */
function questionMode(value, defaultMode) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === MODE_QUICK || raw === MODE_FULL) return raw
  const fallback = typeof defaultMode === 'string' ? defaultMode.trim().toLowerCase() : ''
  return fallback === MODE_QUICK ? MODE_QUICK : MODE_FULL
}

/**
 * Normalize `clarify_ask` arguments into the panel's wire shape.
 *
 * Bad input is repaired rather than thrown away: a question without options is
 * still a perfectly good free-text question, and a long list is truncated with
 * the remainder dropped — the model is told what happened in `note`.
 *
 * Questions are filtered in a fixed order — impact, then `goal` once work has
 * started, then the `quick` cap, then the batch cap — so a discarded question
 * never takes a slot away from a real one. Survivors keep their order and are
 * re-numbered from `q1`, which is what keeps the panel's answer drafts from
 * colliding. Each rule that drops something appends one segment to `note`; the
 * segments are joined with `；` so the model reads one explanation, not five.
 *
 * @param {unknown} args
 * @param {{ startedWork?: boolean, defaultMode?: string }} [settings] - Session facts the caller resolved.
 * @returns {{ ok: true, intro: string, mode: string, focus: string, questions: object[], note: string } | { ok: false, note: string }}
 */
export function normalizeAsk(args, settings = {}) {
  const raw = args !== null && typeof args === 'object' ? args : {}
  const options = settings !== null && typeof settings === 'object' ? settings : {}
  const startedWork = options.startedWork === true
  const mode = questionMode(raw.mode, options.defaultMode)
  const list = Array.isArray(raw.questions) ? raw.questions : []
  const questions = []
  const notes = []
  let emptyCount = 0
  let droppedCount = 0
  let expiredGoalCount = 0
  let quickDroppedCount = 0
  let overflowCount = 0

  for (const entry of list) {
    const source = entry !== null && typeof entry === 'object' ? entry : {}
    const question = typeof source.question === 'string' ? source.question.trim() : ''
    if (question === '') {
      emptyCount += 1
      continue
    }
    // 1. The filter this tool exists for: an answer the model would not act on
    //    does not earn a decision from the person.
    if (!changesOutput(source.impact)) {
      droppedCount += 1
      continue
    }
    // 2. A goal question asked after work started is stale by construction.
    const kind = questionKind(source.kind)
    if (startedWork && kind === KIND_GOAL) {
      expiredGoalCount += 1
      continue
    }
    // 3. Quick mode is a one-question interview; the rest are noise.
    if (mode === MODE_QUICK && questions.length >= 1) {
      quickDroppedCount += 1
      continue
    }
    // 4. The batch cap comes last so the filters above do not spend its slots.
    if (questions.length >= MAX_QUESTIONS) {
      overflowCount += 1
      continue
    }
    const choices = []
    if (Array.isArray(source.options)) {
      for (const option of source.options.slice(0, MAX_OPTIONS)) {
        const item = typeof option === 'string' ? { label: option } : option
        const label = typeof item?.label === 'string' ? item.label.trim() : ''
        if (label === '') continue
        const description = typeof item?.description === 'string' ? item.description.trim() : ''
        choices.push(description === '' ? { label } : { label, description })
      }
    }
    questions.push({
      // Ids are ours: a model-supplied duplicate id would let two questions share
      // one answer draft in the panel, so the wire id is always positional.
      id: `q${questions.length + 1}`,
      header: typeof source.header === 'string' ? source.header.trim() : '',
      question,
      detail: typeof source.detail === 'string' ? source.detail.trim() : '',
      kind,
      options: choices,
      allowCustom: source.allowCustom !== false,
    })
  }

  if (droppedCount > 0) notes.push(`${droppedCount} 个问题不会改变产出，已丢弃`)
  if (expiredGoalCount > 0) notes.push(`会话已经开始动手，goal 类问题已过期，已丢弃 ${expiredGoalCount} 题`)
  if (quickDroppedCount > 0) notes.push(`快问模式只问 1 题，${quickDroppedCount} 题已丢弃`)
  if (overflowCount > 0) notes.push(`问题超过 ${MAX_QUESTIONS} 个，后面的被丢掉了`)
  if (emptyCount > 0) notes.push('有空问题被跳过了')

  if (questions.length === 0) {
    if (expiredGoalCount > 0) {
      return { ok: false, note: `${notes.join('；')}。不要再问目标，按已经开工的方向继续。` }
    }
    if (droppedCount > 0) {
      return { ok: false, note: `${droppedCount} 个问题都不会改变产出，已全部丢弃。不要提问，直接按默认值开工。` }
    }
    return { ok: false, note: '没有问题可以问：`questions` 至少要有一个非空的 `question`' }
  }

  return {
    ok: true,
    intro: typeof raw.intro === 'string' ? raw.intro.trim() : '',
    mode,
    focus: typeof raw.focus === 'string' ? raw.focus.trim() : '',
    questions,
    note: notes.join('；'),
  }
}

/**
 * The text the model reads after an interview, one line per question.
 *
 * @param {{ status: string, answers?: object[], note?: string }} response
 * @param {object[]} questions
 * @returns {string}
 */
export function askResultText(response, questions) {
  switch (response.status) {
    case 'answered': {
      const answers = Array.isArray(response.answers) ? response.answers : []
      const lines = questions.map((question, index) => {
        const answer = answers.find(item => item.id === question.id) ?? answers[index] ?? { selected: [], custom: '' }
        const selected = Array.isArray(answer.selected) ? answer.selected : []
        const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
        const parts = [...selected]
        if (custom !== '') parts.push(`自己写：${custom}`)
        const shown = parts.length === 0 ? '（没选也没写）' : parts.join('；')
        return `${index + 1}. 【${question.header || question.question.slice(0, 12)}】${shown}`
      })
      // A filtered batch answers fewer questions than it was asked; the note is
      // the model's only explanation, so it belongs in the text it actually reads.
      const note = typeof response.note === 'string' ? response.note.trim() : ''
      const dropped = note === '' ? '' : `\n\n${note}`
      return `用户答完了：\n${lines.join('\n')}${dropped}\n\n按这些答案继续；仍然没定的点写进需求卡的「关键假设」，不要再问第二遍。`
    }
    case 'skipped':
      return '用户跳过了这次访谈（这是「你定」的意思，不是拒绝）。用你推荐的默认值把缺口补上，写进需求卡的「关键假设」，然后调用 `clarify_brief` 提交，不要再问。'
    case 'dismissed':
      return '用户关掉了提问面板，并把这一轮的话筒拿回去了（这是中断，不是拒绝）。本轮到此结束：不要继续施工，也不要再问，等用户的下一条消息。'
    case 'timeout':
      return '用户一直没有回答，提问超时了。把这些问题整理成一段话贴在回复里，等用户回；不要在这一轮开始施工。'
    case 'no_client':
      return `这个环境没有可用的提问界面（${response.note ?? '没有应答方'}）。把问题整理成一段话贴在回复里，等用户回答后再继续；不要在这一轮开始施工。`
    case 'busy':
      return '这个会话已经有一组问题在等回答了，不要重复提问；等那组答完再决定。'
    case 'off':
      return '这个会话没有开启澄清模式：问题没有发给用户。不要为这件事停下，直接按你的理解执行。'
    default:
      return `问题没有提交成功：${response.note ?? '未知原因'}。修好之后再调用 \`clarify_ask\`。`
  }
}

/**
 * The text the model reads for one review outcome.
 *
 * @param {{ action: string, feedback?: string, note?: string }} outcome
 * @param {string} brief
 * @returns {string}
 */
export function resultText(outcome, brief) {
  switch (outcome.action) {
    case 'approved': {
      const saved = typeof outcome.cardPath === 'string' && outcome.cardPath !== ''
        ? `\n\n需求卡已落盘：${outcome.cardPath}`
        : ''
      return `用户已确认需求卡，可以开工了。\n\n【已确认的需求卡】\n${brief}\n\n按卡执行，不要顺手扩大范围。执行中若发现与卡冲突的新信息，先说明冲突与建议，再动手。${saved}`
    }
    case 'needs_more': {
      const feedback = outcome.feedback === undefined || outcome.feedback.trim() === ''
        ? '（用户没有写文字，只是选择了继续追问）'
        : outcome.feedback.trim()
      return `用户还没有确认这份需求卡。他的补充：\n${feedback}\n\n按补充再问一轮（最多两轮），把仍然不确定的点放进一次 \`clarify_ask\`，然后再次调用 \`clarify_brief\`。在确认之前不要开始施工。`
    }
    case 'skipped':
      return '用户跳过了这次访谈：用你推荐的默认值补上「关键假设」，然后直接开工，不要再问。'
    case 'dismissed':
      return '用户关掉了确认面板，并把这一轮的话筒拿回去了（这是中断，不是拒绝）。本轮到此结束：不要继续施工，也不要再调用本工具，等用户的下一条消息。'
    case 'off':
      return '这个会话没有开启澄清模式：工具没有向用户展示需求卡，也没有做任何确认。不要为这件事停下，直接按你的理解执行。'
    case 'no_channel':
      return `这个环境没有可用的提问界面（${outcome.note === undefined || outcome.note === '' ? '没有应答方' : outcome.note}），需求卡没能展示给用户。把下面的卡片原样贴在回复里，请用户确认或修改，等他回复后再开工；不要在这一轮就开始改东西。\n\n【需求卡】\n${brief}`
    default:
      return `需求卡没有提交成功：${outcome.note ?? '未知原因'}。修好之后重新调用 \`clarify_brief\`。`
  }
}

/**
 * Ask the built-in channel one question at a time.
 *
 * The built-in question UI gives a whole batch a single answer box, which is
 * exactly the bug this plugin exists to avoid — so the fallback never batches.
 *
 * @param {object[]} questions
 * @param {{ agent?: object, signal?: AbortSignal }} exec
 * @param {(request: object) => Promise<{ status: string, answers?: object[], note?: string }>} legacyAsk
 * @returns {Promise<{ status: string, answers?: object[], note?: string }>}
 */
async function askLegacyOneByOne(questions, exec, legacyAsk) {
  const answers = []
  for (const question of questions) {
    const response = await legacyAsk({
      questions: [{
        id: question.id,
        header: question.header === '' ? undefined : question.header,
        question: question.question,
        detail: question.detail === '' ? undefined : question.detail,
        options: question.options.length === 0 ? undefined : question.options,
      }],
      agent: exec?.agent,
      signal: exec?.signal,
    })
    if (response.status !== 'answered') return response
    const item = Array.isArray(response.answers) ? response.answers[0] : undefined
    answers.push({
      id: question.id,
      selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
      custom: typeof item?.custom === 'string' ? item.custom.trim() : '',
    })
  }
  return { status: 'answered', answers }
}

/**
 * Map one answered review back to an action.
 *
 * @param {{ status: string, answers?: object[], note?: string }} response
 * @returns {{ action: string, feedback?: string, note?: string }}
 */
function reviewOutcome(response) {
  if (response.status === 'answered') {
    const item = Array.isArray(response.answers) ? response.answers[0] : undefined
    const selected = Array.isArray(item?.selected) ? item.selected.map(String) : []
    const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
    if (selected.includes(APPROVE_LABEL) && custom === '') return { action: 'approved' }
    const alternatives = selected.filter(label => label !== APPROVE_LABEL)
    return { action: 'needs_more', feedback: custom !== '' ? custom : alternatives.join(' / ') }
  }
  if (response.status === 'skipped') return { action: 'skipped' }
  if (response.status === 'dismissed') return { action: 'dismissed' }
  return { action: 'no_channel', note: response.note ?? response.status }
}

/**
 * @param {object} deps
 * @param {import('./state.js').StateStore} deps.store
 * @param {{ clientAlive: (sessionId: string) => boolean, ask: (sessionId: string, request: object) => Promise<object> }} deps.interview
 * @param {(request: { questions: object[], agent?: object, signal?: AbortSignal }) => Promise<{ status: string, answers?: object[], note?: string }>} deps.legacyAsk
 * @param {import('./preferences.js').PreferenceStore} [deps.preferences] - Archive the next interview cites.
 * @param {boolean} [deps.cardFile] - `false` disables writing the markdown card file.
 * @param {string} [deps.cardFileDir] - Explicit card directory, overriding `<cwd>/.dsh/clarify`.
 * @param {(sessionId: string) => boolean} [deps.hasStartedWork] - Whether this session already used a writing tool.
 * @param {string} [deps.defaultMode] - Default interview mode: `quick` or `full`.
 * @param {import('./metrics.js').MetricsStore} [deps.metrics] - Optional interview metrics sink.
 * @param {object} [deps.logger]
 * @returns {object[]} tool definitions
 */
export function createTools({
  store,
  interview,
  legacyAsk,
  logger,
  preferences,
  cardFile = true,
  cardFileDir = '',
  hasStartedWork = () => false,
  defaultMode = MODE_FULL,
  metrics,
}) {
  const resolvedDefaultMode = questionMode(undefined, defaultMode)
  /**
   * execute and render receive the same frozen `args` object. Remembering the
   * survivors per call lets the renderer echo exactly the questions that were
   * asked, even when session state (a stale `goal` question) dropped some.
   */
  const askedQuestions = new WeakMap()

  /**
   * Tool statuses that have an honest metric equivalent. Metrics keeps a closed
   * vocabulary (`answered`…`off`); a status it cannot express (`invalid`,
   * `busy`) means no interview happened, so nothing is recorded.
   */
  const METRIC_STATUS = new Map([
    ['answered', 'answered'],
    ['dismissed', 'dismissed'],
    ['skipped', 'skipped'],
    ['timeout', 'timeout'],
    ['no_client', 'no_client'],
    ['off', 'off'],
  ])

  /** Review outcomes share the same vocabulary; a review is one asked question. */
  const REVIEW_STATUS = new Map([
    ['approved', 'answered'],
    ['needs_more', 'answered'],
    ['dismissed', 'dismissed'],
    ['skipped', 'skipped'],
    ['no_channel', 'no_client'],
    ['off', 'off'],
  ])

  /**
   * Questions the filters kept out of the panel: proposed minus asked.
   *
   * @param {unknown} args
   * @param {{ ok: boolean, questions?: object[] }} normalized
   * @returns {number}
   */
  function droppedQuestions(args, normalized) {
    const proposed = Array.isArray(args?.questions) ? args.questions.length : 0
    const asked = normalized.ok === true && Array.isArray(normalized.questions)
      ? normalized.questions.length
      : 0
    return Math.max(0, proposed - asked)
  }

  /**
   * Record one interview attempt, best-effort.
   *
   * Metrics must never be able to fail a tool call: a reporting convenience is
   * not worth losing an answer over.
   *
   * @param {{ sessionId?: string, kind: string, asked: number, dropped: number, status: string, ms: number }} input
   * @returns {Promise<void>}
   */
  async function recordInterview(input) {
    if (typeof metrics?.record !== 'function') return
    const status = METRIC_STATUS.get(input.status)
    if (status === undefined) return
    try {
      await metrics.record({ ...input, status })
    } catch (error) {
      logger?.warn?.(`dsh-clarify: could not record interview metrics: ${error?.message ?? error}`)
    }
  }

  /**
   * Record an approval in both memories: the JSON archive that the next intake
   * cites, and — unless disabled — one markdown file a person and a diff can
   * read.
   *
   * The two are independent on purpose: a failure here can only cost a
   * convenience, never the approval itself (which is already in `store`).
   *
   * @param {string} sessionId
   * @param {string} card
   * @param {object | undefined} agent
   * @returns {Promise<string>} the written card path, or `''`
   */
  async function recordApproval(sessionId, card, agent) {
    let remembered = null
    try {
      remembered = (await preferences?.remember?.({ card, sessionId })) ?? null
    } catch (error) {
      logger?.warn?.(`dsh-clarify: could not remember the approved card: ${error?.message ?? error}`)
    }
    if (cardFile === false) return ''
    // No cwd means no project to put a card in; an explicit `cardFileDir` still
    // needs the session to be a real workspace, so the gate is the same.
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd.trim() : ''
    if (cwd === '') return ''
    const dir = resolveCardDir({ cwd, config: { cardFileDir } })
    if (dir === '') return ''
    try {
      const written = await writeCard({
        dir,
        card,
        title: remembered?.title,
        approvedAt: remembered?.approvedAt,
        sessionId,
      })
      return written.path
    } catch (error) {
      logger?.warn?.(`dsh-clarify: could not write the card file: ${error?.message ?? error}`)
      return ''
    }
  }

  /**
   * Run one review through the panel when it is there, otherwise through the
   * built-in channel (which handles exactly one question well).
   *
   * @param {string} sessionId
   * @param {{ detail: string, agent?: object, signal?: AbortSignal }} request
   */
  async function runReview(sessionId, request) {
    const payload = {
      title: '需求确认',
      question: '这份需求卡可以开工吗？',
      detail: request.detail,
      options: [
        { label: APPROVE_LABEL, description: '按这张卡执行，不要再问了' },
        { label: ASK_MORE_LABEL, description: '我补充信息，你继续问' },
        { label: SELF_EDIT_LABEL, description: '我在下面直接写要改什么' },
      ],
      allowCustom: true,
    }
    if (interview?.clientAlive?.(sessionId) === true) {
      const response = await interview.ask(sessionId, { kind: 'review', payload })
      if (response.status === 'answered') {
        const item = Array.isArray(response.answers) ? response.answers[0] : undefined
        return {
          status: 'answered',
          answers: [{
            id: 'review',
            selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
            custom: typeof item?.custom === 'string' ? item.custom.trim() : '',
          }],
        }
      }
      return response
    }
    return legacyAsk({
      questions: [{ id: 'review', header: '需求确认', question: payload.question, detail: payload.detail, options: payload.options }],
      agent: request.agent,
      signal: request.signal,
    })
  }

  return [{
    name: CLARIFY_ASK,
    description:
      '向用户提出开工前必须确定的问题（澄清模式用；面板会为每题单独给选项和输入框）。'
      + '只提交会改变产出答案的问题：换个答案你会写出不同东西的才问，只改措辞或只是好奇的不要提交。'
      + 'goal 类问题（到底要什么 / 成功标准）只在动手前问；已经开工就只问 input / constraint / context。'
      + '小任务用 mode=quick（只问 1 题），多因素任务用 mode=full；用户说「只问格式」时把 focus 填成「格式」。'
      + '默认只问 1 个最关键的，最多 3 个；每个问题给 2–4 个具体选项，第一个是你推荐的默认值。'
      + '返回后按答案继续，没定的点写进需求卡的关键假设，不要再问第二遍。',
    parameters: {
      type: 'object',
      properties: {
        intro: {
          type: 'string',
          description: '一两句话说明这次要确认什么（显示在面板顶部）。例如「这份报告我准备按预习报告来写，先确认三件事」。',
        },
        mode: {
          type: 'string',
          enum: MODE_VALUES,
          description: 'quick 只问 1 题（小任务）；full 走完整访谈（多因素任务，缺省）。',
        },
        focus: {
          type: 'string',
          description: '只问某个方面时填这里：用户说「只问格式」就填「格式」，面板会显示「只问：格式」。',
        },
        questions: {
          type: 'array',
          description: `1–${MAX_QUESTIONS} 个问题，通常 1–3 个。每题会单独渲染选项和输入框。`,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: '短标题，例如「交付物」「受众」「范围」' },
              question: { type: 'string', description: '问题本身，一句话，具体到能直接回答' },
              detail: { type: 'string', description: '补充说明或背景（可选，不放进选项标签）' },
              kind: {
                type: 'string',
                enum: KIND_VALUES,
                description: '信息类型：goal（到底要什么 / 成功标准，只在动手前问）/ input（素材与细节，默认）/ constraint（限制）/ context（背景）。已经开工后 goal 会被丢弃。',
              },
              impact: {
                type: 'string',
                enum: IMPACT_VALUES,
                description: '换个答案会不会改变你写出的东西：changes-output（默认）会改变；changes-wording 只改措辞；nice-to-know 只是好奇。只有 changes-output 会进面板，其余丢弃。',
              },
              options: {
                type: 'array',
                description: `2–${MAX_OPTIONS} 个具体选项；第一个是你推荐的默认值。没有选项时用户只能自己写。`,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项文字，具体到能直接开工' },
                    description: { type: 'string', description: '一句话解释这个选项的后果（可选）' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              allowCustom: { type: 'boolean', description: '是否允许用户自己写答案，默认 true' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['answered', 'off', 'skipped', 'dismissed', 'timeout', 'no_client', 'busy', 'invalid'],
          },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
              required: ['id', 'selected', 'custom'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['status', 'answers', 'note'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const remembered = args !== null && typeof args === 'object' ? askedQuestions.get(args) : undefined
        if (remembered !== undefined) return text(askResultText(value, remembered))
        const normalized = normalizeAsk(args, { defaultMode: resolvedDefaultMode })
        return text(askResultText(value, normalized.ok ? normalized.questions : []))
      },
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const sessionId = exec?.agent?.session?.id
      const enabled = store.get(sessionId).enabled === true
      let startedWork = false
      if (enabled) {
        try {
          startedWork = hasStartedWork(sessionId) === true
        } catch (error) {
          // A broken probe must never block a question; treat it as "not started".
          logger?.warn?.(`dsh-clarify: hasStartedWork failed: ${error?.message ?? error}`)
        }
      }
      const normalized = normalizeAsk(args, { startedWork, defaultMode: resolvedDefaultMode })
      if (normalized.ok !== true) {
        await recordInterview({
          sessionId,
          kind: 'questions',
          asked: 0,
          dropped: droppedQuestions(args, normalized),
          status: 'invalid',
          ms: Date.now() - startedAt,
        })
        return { status: 'invalid', answers: [], note: normalized.note }
      }
      // execute and render share the same frozen args object, so the renderer can
      // echo exactly the questions this call decided to ask.
      if (args !== null && typeof args === 'object') askedQuestions.set(args, normalized.questions)
      // The panel only receives the survivors, so the model would otherwise
      // never learn that some questions were filtered out. The note rides on
      // the tool result, where the model does read it.
      const dropped = normalized.note
      if (!enabled) {
        await recordInterview({
          sessionId,
          kind: 'questions',
          asked: normalized.questions.length,
          dropped: droppedQuestions(args, normalized),
          status: 'off',
          ms: Date.now() - startedAt,
        })
        return { status: 'off', answers: [], note: dropped }
      }

      const payload = {
        kind: 'questions',
        intro: normalized.intro,
        questions: normalized.questions,
        note: normalized.note,
        mode: normalized.mode,
        focus: normalized.focus,
      }

      let response
      try {
        response = interview?.clientAlive?.(sessionId) === true
          ? await interview.ask(sessionId, { kind: 'questions', payload })
          : await askLegacyOneByOne(normalized.questions, exec, legacyAsk)
      } catch (error) {
        logger?.warn?.(`dsh-clarify: ask failed: ${error?.message ?? error}`)
        response = { status: 'no_client', note: String(error?.message ?? error) }
      }

      if (response.status === 'dismissed') {
        try {
          exec?.concludeTurn?.()
        } catch {
          /* the caller may not expose it */
        }
      }

      const reported = typeof response.note === 'string' ? response.note : ''
      const result = {
        status: response.status,
        answers: Array.isArray(response.answers) ? response.answers : [],
        note: [reported, dropped].filter(item => item !== '').join('；'),
      }
      await recordInterview({
        sessionId,
        kind: 'questions',
        asked: normalized.questions.length,
        dropped: droppedQuestions(args, normalized),
        status: result.status,
        ms: Date.now() - startedAt,
      })
      return result
    },
  }, {
    name: CLARIFY_BRIEF,
    description:
      '把写好的需求卡提交给用户做开工确认（澄清模式用）。'
      + '澄清模式下，问完关键问题、写好需求卡之后必须调用它；用户确认（approved=true）之后才开始施工。'
      + '需求卡要短、可扫读，字段：目标 / 交付物 / 必须满足 / 明确不做 / 关键假设 / 验收方式 / 验收清单（3–5 条可勾选） / 待定项。'
      + `可勾选的验收项放进 \`checklist\`（最多 ${MAX_CHECKLIST} 条），会追加到卡片末尾。`,
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: `完整的需求卡（markdown，最多 ${MAX_BRIEF_CHARS} 字）。用户会原样看到它，所以写人能直接判断的句子，不要写过程。`,
        },
        checklist: {
          type: 'array',
          description: `验收清单：${MAX_CHECKLIST} 条以内、可勾选的具体条目（3–5 条最好），会以「**验收清单** - [ ] …」追加到卡片末尾。`,
          maxItems: MAX_CHECKLIST,
          items: { type: 'string' },
        },
        questions: {
          type: 'array',
          description: '这一轮你向用户问过的问题（一行一个），用于在确认页里回放你的提问。',
          items: { type: 'string' },
        },
        open: {
          type: 'array',
          description: '仍然没有定的点。没有就留空——留空比编一个待定项好。',
          items: { type: 'string' },
        },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          action: {
            type: 'string',
            enum: ['approved', 'needs_more', 'dismissed', 'skipped', 'off', 'no_channel', 'invalid'],
          },
          feedback: { type: 'string' },
          note: { type: 'string' },
          cardPath: { type: 'string' },
        },
        required: ['approved', 'action', 'feedback', 'note', 'cardPath'],
        additionalProperties: false,
      },
      render: (args, value) => text(resultText(value, cardFrom(args))),
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const card = cardFrom(args)
      const sessionId = exec?.agent?.session?.id
      const questions = Array.isArray(args?.questions) ? args.questions.map(String) : []

      if (card === '') {
        await recordInterview({
          sessionId,
          kind: 'review',
          asked: 0,
          dropped: 0,
          status: 'invalid',
          ms: Date.now() - startedAt,
        })
        return {
          approved: false,
          action: 'invalid',
          feedback: '',
          note: '需求卡是空的。把目标、交付物、必须满足、明确不做、关键假设、验收方式写进去再提交。',
          cardPath: '',
        }
      }

      if (store.get(sessionId).enabled !== true) {
        await recordInterview({
          sessionId,
          kind: 'review',
          asked: 0,
          dropped: 0,
          status: 'off',
          ms: Date.now() - startedAt,
        })
        return { approved: true, action: 'off', feedback: '', note: '', cardPath: '' }
      }

      let outcome
      try {
        const response = await runReview(sessionId, {
          detail: reviewDetail(card, questions),
          agent: exec?.agent,
          signal: exec?.signal,
        })
        outcome = reviewOutcome(response)
      } catch (error) {
        logger?.warn?.(`dsh-clarify: review failed: ${error?.message ?? error}`)
        outcome = { action: 'no_channel', note: String(error?.message ?? error) }
      }

      if (outcome.action === 'approved') {
        try {
          await store.approve(sessionId, card)
        } catch (error) {
          logger?.warn?.(`dsh-clarify: could not store the approved card: ${error?.message ?? error}`)
        }
        const cardPath = await recordApproval(sessionId, card, exec?.agent)
        await recordInterview({
          sessionId,
          kind: 'review',
          asked: 1,
          dropped: 0,
          status: REVIEW_STATUS.get('approved'),
          ms: Date.now() - startedAt,
        })
        return { approved: true, action: 'approved', feedback: '', note: '', cardPath }
      }

      if (outcome.action === 'dismissed') {
        try {
          exec?.concludeTurn?.()
        } catch {
          /* the caller may not expose it */
        }
        await recordInterview({
          sessionId,
          kind: 'review',
          asked: 1,
          dropped: 0,
          status: REVIEW_STATUS.get('dismissed'),
          ms: Date.now() - startedAt,
        })
        return { approved: false, action: 'dismissed', feedback: '', note: '', cardPath: '' }
      }

      const action = outcome.action === 'needs_more'
        ? 'needs_more'
        : outcome.action === 'skipped'
          ? 'skipped'
          : outcome.action === 'no_channel'
            ? 'no_channel'
            : 'invalid'
      await recordInterview({
        sessionId,
        kind: 'review',
        // A review that never reached the person was not asked; the outcome
        // itself still counts as an attempt.
        asked: action === 'needs_more' || action === 'skipped' ? 1 : 0,
        dropped: 0,
        status: REVIEW_STATUS.get(action) ?? 'invalid',
        ms: Date.now() - startedAt,
      })
      return {
        approved: false,
        action,
        feedback: typeof outcome.feedback === 'string' ? outcome.feedback : '',
        note: typeof outcome.note === 'string' ? outcome.note : '',
        cardPath: '',
      }
    },
  }]
}

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStateStore } from '../lib/state.js'
import {
  APPROVE_LABEL,
  CLARIFY_ASK,
  CLARIFY_BRIEF,
  IMPACT_VALUES,
  KIND_VALUES,
  MAX_CHECKLIST,
  MAX_QUESTIONS,
  MODE_VALUES,
  askResultText,
  cardFrom,
  createTools,
  normalizeAsk,
  resultText,
} from '../lib/tools.js'

/**
 * A store plus the two tool dependencies.
 *
 * `panel` controls whether the fake panel is "present"; `review` and `panelAsk`
 * decide what it answers; `legacy` records and answers the built-in path.
 */
async function fixture({
  enabled = true,
  panel = true,
  panelAsk,
  review,
  legacy,
  startedWork = false,
  defaultMode,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-tool-'))
  const store = createStateStore({ file: path.join(directory, 'state.json') })
  await store.load()
  await store.setEnabled('session-1', enabled)

  const legacyCalls = []
  const panelCalls = []
  const tools = createTools({
    store,
    interview: {
      clientAlive: () => panel,
      async ask(sessionId, request) {
        panelCalls.push({ sessionId, request })
        if (request.kind === 'review') {
          return review ?? { status: 'answered', answers: [{ id: 'review', selected: [APPROVE_LABEL], custom: '' }] }
        }
        return panelAsk ?? { status: 'answered', answers: [] }
      },
    },
    legacyAsk: async (request) => {
      legacyCalls.push(request)
      if (typeof legacy === 'function') return legacy(request, legacyCalls.length)
      return legacy ?? { status: 'answered', answers: [{ id: request.questions[0].id, selected: ['（内置）'], custom: '' }] }
    },
    hasStartedWork: () => startedWork,
    defaultMode,
  })
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  return { store, tools, byName, legacyCalls, panelCalls }
}

const exec = (overrides = {}) => ({
  agent: { session: { id: 'session-1' } },
  callId: 'call-1',
  signal: undefined,
  ...overrides,
})

const TWO_QUESTIONS = {
  intro: '先确认两件事',
  questions: [
    {
      header: '交付物',
      question: '要什么形态？',
      options: [{ label: '8 页 A4 PDF' }, { label: 'docx' }],
    },
    {
      header: '受众',
      question: '给谁看？',
      options: [{ label: '老师' }],
    },
  ],
}

test('the panel receives every question and the answers come back as one result', async () => {
  const { byName, panelCalls } = await fixture({
    panelAsk: {
      status: 'answered',
      answers: [
        { id: 'q1', selected: ['8 页 A4 PDF'], custom: '' },
        { id: 'q2', selected: [], custom: '只给助教看' },
      ],
    },
  })
  const tool = byName[CLARIFY_ASK]
  const value = await tool.execute(TWO_QUESTIONS, exec())
  assert.equal(value.status, 'answered')
  assert.equal(value.answers.length, 2)
  assert.equal(panelCalls.length, 1)
  assert.equal(panelCalls[0].request.kind, 'questions')
  assert.equal(panelCalls[0].request.payload.questions.length, 2)
  const rendered = tool.output.render(TWO_QUESTIONS, value)[0].text
  assert.ok(rendered.includes('8 页 A4 PDF'))
  assert.ok(rendered.includes('自己写：只给助教看'))
})

test('without a panel the fallback asks one question at a time', async () => {
  const { byName, legacyCalls, panelCalls } = await fixture({ panel: false })
  const value = await byName[CLARIFY_ASK].execute(TWO_QUESTIONS, exec())
  assert.equal(value.status, 'answered')
  assert.equal(value.answers.length, 2)
  // The whole point: never a batch, because the built-in UI has one box.
  assert.equal(legacyCalls.length, 2)
  assert.equal(legacyCalls[0].questions.length, 1)
  assert.equal(legacyCalls[1].questions.length, 1)
  assert.equal(panelCalls.length, 0)
})

test('a dismissed fallback ends the turn instead of asking again', async () => {
  const { byName } = await fixture({
    panel: false,
    legacy: { status: 'dismissed' },
  })
  let concluded = 0
  const value = await byName[CLARIFY_ASK].execute(TWO_QUESTIONS, exec({
    concludeTurn() {
      concluded += 1
    },
  }))
  assert.equal(value.status, 'dismissed')
  assert.equal(concluded, 1)
  assert.ok(askResultText(value, []).includes('本轮到此结束'))
})

test('a skipped interview tells the model to proceed on assumptions', async () => {
  const { byName } = await fixture({ panel: false, legacy: { status: 'skipped' } })
  const value = await byName[CLARIFY_ASK].execute(TWO_QUESTIONS, exec())
  assert.equal(value.status, 'skipped')
  const rendered = askResultText(value, [])
  assert.ok(rendered.includes('跳过了'))
  assert.ok(rendered.includes('不要再问'))
})

test('clarify_ask respects the mode switch and repairs empty input', async () => {
  const { byName } = await fixture({ enabled: false })
  assert.equal((await byName[CLARIFY_ASK].execute(TWO_QUESTIONS, exec())).status, 'off')
  const invalid = await byName[CLARIFY_ASK].execute({ questions: [{ question: '  ' }] }, exec())
  assert.equal(invalid.status, 'invalid')
  assert.ok(invalid.note.includes('至少要有一个'))
})

test('question ids are positional even when the model repeats one', () => {
  const normalized = normalizeAsk({
    questions: [
      { id: 'same', question: '第一题' },
      { id: 'same', question: '第二题' },
    ],
  })
  assert.deepEqual(normalized.questions.map(question => question.id), ['q1', 'q2'])
})

test('normalizeAsk caps the batch, drops empty questions and keeps labels', () => {
  const many = {
    questions: Array.from({ length: MAX_QUESTIONS + 2 }, (_, index) => ({ question: `问题 ${index + 1}` })),
  }
  const normalized = normalizeAsk(many)
  assert.equal(normalized.ok, true)
  assert.equal(normalized.questions.length, MAX_QUESTIONS)
  assert.ok(normalized.note.includes('超过'))

  const repaired = normalizeAsk({
    questions: [
      { question: '要几页？', options: [{ label: ' 8 页 ' }, { label: '' }, 'docx'] },
      { question: '' },
    ],
  })
  assert.equal(repaired.questions.length, 1)
  assert.deepEqual(repaired.questions[0].options.map(option => option.label), ['8 页', 'docx'])
  assert.equal(repaired.questions[0].allowCustom, true)
  assert.ok(repaired.note.includes('空问题'))
})

test('impact defaults to changes-output, so an ordinary question keeps its slot', () => {
  const normalized = normalizeAsk({
    questions: [
      { question: '要什么形态？' },
      { question: '给谁看？', impact: 'changes-output' },
      { question: '要几页？', impact: ' changes-output ' },
      { question: '范围？', impact: '' },
    ],
  })
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.questions.map(question => question.question), ['要什么形态？', '给谁看？', '要几页？', '范围？'])
  assert.equal(normalized.note, '')
})

test('questions that would not change the output are dropped and counted in the note', () => {
  const normalized = normalizeAsk({
    questions: [
      { question: '要几页？' },
      { question: '标题用「预习报告」还是「预习作业」？', impact: 'changes-wording' },
      { question: '你平时用哪个编辑器？', impact: 'nice-to-know' },
    ],
  })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.questions.length, 1)
  assert.equal(normalized.questions[0].question, '要几页？')
  assert.equal(normalized.note, '2 个问题不会改变产出，已丢弃')
})

test('the impact filter keeps order and re-numbers the survivors from q1', () => {
  const normalized = normalizeAsk({
    questions: [
      { question: '第一题', impact: 'nice-to-know' },
      { question: '第二题' },
      { question: '第三题', impact: 'changes-wording' },
      { question: '第四题' },
    ],
  })
  assert.deepEqual(normalized.questions.map(question => question.id), ['q1', 'q2'])
  assert.deepEqual(normalized.questions.map(question => question.question), ['第二题', '第四题'])
  assert.ok(normalized.note.includes('2 个问题不会改变产出'))
})

test('the impact filter runs before the batch cap', () => {
  const normalized = normalizeAsk({
    questions: [
      { question: '措辞一', impact: 'changes-wording' },
      { question: '好奇心一', impact: 'nice-to-know' },
      { question: '问题一' },
      { question: '问题二' },
      { question: '问题三' },
      { question: '问题四' },
    ],
  })
  // Two dropped questions do not eat two of the five real slots.
  assert.equal(normalized.questions.length, 4)
  assert.ok(!normalized.note.includes('超过'))
  assert.ok(normalized.note.includes('2 个问题不会改变产出'))
})

test('a batch of nothing but non-output questions never opens the panel', async () => {
  const { byName, panelCalls, legacyCalls } = await fixture()
  const value = await byName[CLARIFY_ASK].execute({
    questions: [
      { question: '你平时用什么编辑器？', impact: 'nice-to-know' },
      { question: '标题换个说法？', impact: 'changes-wording' },
    ],
  }, exec())
  assert.equal(value.status, 'invalid')
  assert.ok(value.note.includes('不会改变产出'))
  assert.ok(value.note.includes('不要提问'))
  assert.equal(panelCalls.length, 0)
  assert.equal(legacyCalls.length, 0)
})

test('render pairs the survivors with their answers and says nothing about dropped ones', async () => {
  const args = {
    questions: [
      { header: '交付物', question: '要什么形态？', options: [{ label: '8 页 A4 PDF' }] },
      { header: '编辑器', question: '用什么编辑器？', impact: 'nice-to-know' },
    ],
  }
  const { byName } = await fixture({
    panelAsk: { status: 'answered', answers: [{ id: 'q1', selected: ['8 页 A4 PDF'], custom: '' }] },
  })
  const tool = byName[CLARIFY_ASK]
  const value = await tool.execute(args, exec())
  assert.equal(value.status, 'answered')
  const rendered = tool.output.render(args, value)[0].text
  assert.ok(rendered.includes('【交付物】8 页 A4 PDF'))
  assert.ok(!rendered.includes('编辑器'))
})

test('clarify_ask advertises the impact filter to the model', async () => {
  const { byName } = await fixture()
  const schema = byName[CLARIFY_ASK].parameters.properties.questions.items.properties
  assert.deepEqual(schema.impact.enum, IMPACT_VALUES)
  assert.ok(schema.impact.description.includes('changes-output'))
  assert.ok(byName[CLARIFY_ASK].description.includes('只提交会改变产出答案的问题'))
})

test('goal is an ordinary kind before work starts', () => {
  const normalized = normalizeAsk({ questions: [{ question: '到底要什么？', kind: 'goal' }] })
  assert.equal(normalized.questions[0].kind, 'goal')
})

test('goal questions are dropped once the session has started writing', async () => {
  const args = {
    questions: [
      { header: '目标', question: '到底要什么？', kind: 'goal' },
      { header: '页数', question: '要几页？' },
      { header: '限制', question: '有截止时间吗？', kind: 'constraint' },
    ],
  }
  const { byName, panelCalls } = await fixture({
    startedWork: true,
    panelAsk: {
      status: 'answered',
      answers: [
        { id: 'q1', selected: ['8 页'], custom: '' },
        { id: 'q2', selected: ['明天'], custom: '' },
      ],
    },
  })
  const tool = byName[CLARIFY_ASK]
  const value = await tool.execute(args, exec())
  const asked = panelCalls[0].request.payload.questions
  assert.deepEqual(asked.map(question => question.question), ['要几页？', '有截止时间吗？'])
  assert.deepEqual(asked.map(question => question.id), ['q1', 'q2'])
  assert.deepEqual(asked.map(question => question.kind), ['input', 'constraint'])
  assert.ok(value.note.includes('会话已经开始动手，goal 类问题已过期，已丢弃 1 题'))
  const rendered = tool.output.render(args, value)[0].text
  assert.ok(rendered.includes('【页数】8 页'))
  // The drop explanation is in the text the model reads, not only in `value.note`.
  assert.ok(rendered.includes('goal 类问题已过期'))
  // The stale goal question must not reappear (mislabeled) in the model echo.
  assert.ok(!rendered.includes('到底要什么'))
})

test('starting work turns a goal-only batch into invalid, not a panel', async () => {
  const { byName, panelCalls } = await fixture({ startedWork: true })
  const value = await byName[CLARIFY_ASK].execute({
    questions: [{ question: '到底要什么？', kind: 'goal' }],
  }, exec())
  assert.equal(value.status, 'invalid')
  assert.ok(value.note.includes('goal 类问题已过期'))
  assert.ok(value.note.includes('不要再问目标'))
  assert.equal(panelCalls.length, 0)
})

test('quick mode asks exactly the first question and explains the truncation', async () => {
  const args = {
    mode: 'quick',
    questions: [{ question: '第一题' }, { question: '第二题' }, { question: '第三题' }],
  }
  const { byName, panelCalls } = await fixture({
    panelAsk: { status: 'answered', answers: [{ id: 'q1', selected: ['A'], custom: '' }] },
  })
  const value = await byName[CLARIFY_ASK].execute(args, exec())
  const payload = panelCalls[0].request.payload
  assert.equal(payload.questions.length, 1)
  assert.equal(payload.questions[0].question, '第一题')
  assert.equal(payload.questions[0].id, 'q1')
  assert.equal(payload.mode, 'quick')
  assert.ok(value.note.includes('快问模式只问 1 题，2 题已丢弃'))
})

test('the injected defaultMode decides when the call does not', async () => {
  const { byName, panelCalls } = await fixture({
    defaultMode: 'quick',
    panelAsk: { status: 'answered', answers: [{ id: 'q1', selected: ['A'], custom: '' }] },
  })
  const value = await byName[CLARIFY_ASK].execute({
    questions: [{ question: '一' }, { question: '二' }],
  }, exec())
  assert.equal(panelCalls[0].request.payload.mode, 'quick')
  assert.equal(panelCalls[0].request.payload.questions.length, 1)
  assert.ok(value.note.includes('快问模式'))
})

test('focus is passed through to the payload', async () => {
  const normalized = normalizeAsk({ focus: ' 格式 ', questions: [{ question: '用什么字体？' }] })
  assert.equal(normalized.focus, '格式')
  assert.equal(normalized.mode, 'full')

  const { byName, panelCalls } = await fixture()
  await byName[CLARIFY_ASK].execute({
    focus: '格式',
    questions: [{ question: '用什么字体？' }],
  }, exec())
  const payload = panelCalls[0].request.payload
  assert.equal(payload.focus, '格式')
  assert.equal(payload.mode, 'full')
})

test('several filters merge into one note in pipeline order', () => {
  const normalized = normalizeAsk({
    mode: 'quick',
    questions: [
      { question: '标题用什么词？', impact: 'changes-wording' },
      { question: '到底要什么？', kind: 'goal' },
      { question: '第一题' },
      { question: '第二题' },
      { question: '第三题' },
      { question: '第四题' },
      { question: '第五题' },
      { question: '第六题' },
    ],
  }, { startedWork: true })
  // impact → goal → quick all fire, and the model reads one merged explanation.
  assert.equal(normalized.questions.length, 1)
  assert.equal(
    normalized.note,
    '1 个问题不会改变产出，已丢弃；会话已经开始动手，goal 类问题已过期，已丢弃 1 题；快问模式只问 1 题，5 题已丢弃',
  )
})

test('clarify_ask advertises kind, mode and focus', async () => {
  const { byName } = await fixture()
  const parameters = byName[CLARIFY_ASK].parameters
  assert.deepEqual(parameters.properties.mode.enum, MODE_VALUES)
  assert.deepEqual(parameters.properties.questions.items.properties.kind.enum, KIND_VALUES)
  assert.ok(parameters.properties.focus.description.includes('只问格式'))
  assert.ok(byName[CLARIFY_ASK].description.includes('mode=quick'))
})

test('the review goes through the panel and an approval is stored', async () => {
  const { store, byName, panelCalls } = await fixture()
  const value = await byName[CLARIFY_BRIEF].execute({ brief: '# 需求卡\n- 目标：报告' }, exec())
  assert.equal(value.action, 'approved')
  assert.equal(panelCalls[0].request.kind, 'review')
  assert.equal(panelCalls[0].request.payload.question, '这份需求卡可以开工吗？')
  assert.equal(store.view('session-1').brief, '# 需求卡\n- 目标：报告')
})

test('a free-text review answer becomes feedback, not an approval', async () => {
  const { store, byName } = await fixture({
    review: { status: 'answered', answers: [{ id: 'review', selected: [], custom: '要英文版' }] },
  })
  const value = await byName[CLARIFY_BRIEF].execute({ brief: '# 需求卡' }, exec())
  assert.equal(value.action, 'needs_more')
  assert.equal(value.feedback, '要英文版')
  assert.equal(store.view('session-1').approved, false)
  assert.ok(resultText(value, '# 需求卡').includes('要英文版'))
})

test('a skipped review also means "use your defaults"', async () => {
  const { byName } = await fixture({ review: { status: 'skipped' } })
  const value = await byName[CLARIFY_BRIEF].execute({ brief: '# 需求卡' }, exec())
  assert.equal(value.action, 'skipped')
  assert.ok(resultText(value, '# 需求卡').includes('直接开工'))
})

test('without a panel the review still asks exactly one question', async () => {
  const { byName, legacyCalls } = await fixture({
    panel: false,
    legacy: { status: 'answered', answers: [{ id: 'review', selected: [APPROVE_LABEL], custom: '' }] },
  })
  const value = await byName[CLARIFY_BRIEF].execute({ brief: '# 卡' }, exec())
  assert.equal(value.action, 'approved')
  assert.equal(legacyCalls.length, 1)
  assert.deepEqual(legacyCalls[0].questions[0].options.map(option => option.label), ['确认开工', '还要再问', '我自己改'])
})

test('the card the model reads back is exactly the card that was approved', async () => {
  const { store, byName } = await fixture()
  const args = { brief: '# 需求卡\n- 目标：报告', open: ['字体？'] }
  const value = await byName[CLARIFY_BRIEF].execute(args, exec())
  assert.equal(value.approved, true)
  const rendered = byName[CLARIFY_BRIEF].output.render(args, value)[0].text
  assert.ok(rendered.includes(store.view('session-1').brief))
  assert.equal(cardFrom(args), store.view('session-1').brief)
})

test('a checklist is appended to the card and travels with the approval', async () => {
  const args = {
    brief: '# 需求卡\n- 目标：报告',
    checklist: ['PDF 能打开', ' 页数正确 ', '', '术语一致'],
  }
  const { store, byName, panelCalls } = await fixture()
  const value = await byName[CLARIFY_BRIEF].execute(args, exec())
  assert.equal(value.action, 'approved')
  const card = cardFrom(args)
  assert.ok(card.includes('**验收清单**'))
  assert.ok(card.includes('- [ ] PDF 能打开'))
  assert.ok(card.includes('- [ ] 页数正确'))
  assert.ok(card.includes('- [ ] 术语一致'))
  assert.ok(!card.includes('- [ ]  '))
  assert.equal(store.view('session-1').brief, card)
  // The person sees it in the review, and the model reads it back on approval.
  assert.ok(panelCalls[0].request.payload.detail.includes('- [ ] PDF 能打开'))
  const rendered = byName[CLARIFY_BRIEF].output.render(args, value)[0].text
  assert.ok(rendered.includes('**验收清单**'))
})

test('the checklist is capped at six items and needs a non-empty card', () => {
  const card = cardFrom({
    brief: '# 卡',
    checklist: ['一', '二', '三', '四', '五', '六', '七'],
  })
  assert.equal(card.match(/- \[ \]/g).length, MAX_CHECKLIST)
  assert.ok(card.includes('- [ ] 六'))
  assert.ok(!card.includes('- [ ] 七'))

  // A checklist alone is not a card.
  assert.equal(cardFrom({ brief: '  ', checklist: ['一'] }), '')
})

test('clarify_brief advertises the checklist contract', async () => {
  const { byName } = await fixture()
  const parameters = byName[CLARIFY_BRIEF].parameters
  assert.equal(parameters.properties.checklist.maxItems, MAX_CHECKLIST)
  assert.ok(byName[CLARIFY_BRIEF].description.includes('验收清单（3–5 条可勾选）'))
})

test('an empty card is refused before anyone is disturbed', async () => {
  const { byName, legacyCalls, panelCalls } = await fixture()
  const value = await byName[CLARIFY_BRIEF].execute({ brief: '   ' }, exec())
  assert.equal(value.action, 'invalid')
  assert.equal(legacyCalls.length, 0)
  assert.equal(panelCalls.length, 0)
})

test('a failing reviewer is reported, never thrown into the turn', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-tool-'))
  const store = createStateStore({ file: path.join(directory, 'state.json') })
  await store.load()
  await store.setEnabled('session-1', true)
  const tools = createTools({
    store,
    interview: { clientAlive: () => true, ask: async () => { throw new Error('panel exploded') } },
    legacyAsk: async () => { throw new Error('legacy exploded') },
  })
  const briefTool = tools.find(tool => tool.name === CLARIFY_BRIEF)
  const value = await briefTool.execute({ brief: '# 卡' }, exec())
  assert.equal(value.action, 'no_channel')
  assert.ok(value.note.includes('panel exploded'))
})

test('the tools advertise the contracts the prompt relies on', async () => {
  const { byName } = await fixture()
  assert.equal(byName[CLARIFY_ASK].parameters.required[0], 'questions')
  assert.equal(byName[CLARIFY_BRIEF].parameters.required[0], 'brief')
  assert.equal(byName[CLARIFY_BRIEF].parameters.additionalProperties, false)
  assert.ok(byName[CLARIFY_ASK].description.includes('每题单独'))
})

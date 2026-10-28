import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, describe, resolveConfig, DEFAULTS, VERSION } from '../lib/index.js'
import { PROTOCOL, recentCardsDigest } from '../lib/protocol.js'
import { createWorkTracker, WRITE_TOOLS } from '../lib/work-tracker.js'
import { createFakeCtx } from './harness.mjs'

const STATE = '/api/clarify/state'
const PENDING = '/api/clarify/pending'
const ANSWER = '/api/clarify/answer'
const CANCEL = '/api/clarify/cancel'
const TOGGLE = '/api/clarify/toggle'
const CLEAR = '/api/clarify/clear'
const HEALTH = '/api/clarify/health'
const WAITING = '/api/clarify/waiting'

const agent = (id = 'session-1', cwd) => ({
  session: { id, ...(typeof cwd === 'string' && cwd !== '' ? { header: { cwd } } : {}) },
})

async function boot({ omit, userQuestions, connection, config, directory } = {}) {
  const target = directory ?? await mkdtemp(path.join(tmpdir(), 'dsh-clarify-apply-'))
  const harness = createFakeCtx({ omit, userQuestions, connection })
  apply(harness.ctx, { storePath: path.join(target, 'state.json'), ...config })
  // The store loads from disk asynchronously; one macrotask is enough for an
  // empty file (the plugin deliberately does not block on it).
  await new Promise(resolve => setImmediate(resolve))
  return Object.assign(harness, { directory: target })
}

const post = body => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Poll the pending route until the tool has registered its question. */
async function waitPending(harness, session = 'session-1') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await harness.call(PENDING, { url: `${PENDING}?session=${session}` })
    if (response.json.pending !== null) return response.json.pending
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the tool never registered a pending interview')
}

/**
 * Turn the mode on, prove a panel is polling, submit one card and approve it.
 *
 * @param {object} harness
 * @param {{ brief?: string, agent?: object, extra?: object }} [options]
 */
async function approveCard(harness, {
  brief = '# 需求卡\n- 目标：8 页预习报告',
  agent: caller = agent(),
  extra = {},
} = {}) {
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })
  const waiting = harness.tool('clarify_brief').execute({ brief, ...extra }, { agent: caller, callId: 'c1' })
  const pending = await waitPending(harness)
  await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [{ id: 'review', selected: ['确认开工'], custom: '' }],
  }))
  return { value: await waiting, pending }
}

test('one apply wires all surfaces', async () => {
  const harness = await boot({ userQuestions: { ask: async () => ({ answers: [] }) } })
  assert.equal(harness.state.sections.length, 1)
  assert.deepEqual(harness.state.tools.map(tool => tool.name).sort(), ['clarify_ask', 'clarify_brief'])
  assert.equal(harness.state.routes.length, 8)
  assert.deepEqual(harness.state.commands.map(command => command.name), ['clarify'])
  assert.deepEqual(harness.state.warnings, [])
})

test('the panel path: presence, pending questions, answer, tool unblocks', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  // One poll is what makes the host trust that a panel exists.
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const waiting = harness.tool('clarify_ask').execute({
    intro: '先确认两件事',
    questions: [
      { header: '交付物', question: '要几页？', options: [{ label: '8 页', description: '推荐' }, { label: '12 页' }] },
      { header: '受众', question: '给谁看？', options: [{ label: '老师' }] },
    ],
  }, { agent: agent(), callId: 'c1' })

  const pending = await waitPending(harness)
  assert.equal(pending.kind, 'questions')
  assert.equal(pending.questions.length, 2)
  assert.equal(pending.intro, '先确认两件事')

  const answered = await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [
      { id: pending.questions[0].id, selected: ['8 页'], custom: '' },
      { id: pending.questions[1].id, selected: [], custom: '只给助教' },
    ],
  }))
  assert.equal(answered.status, 200)

  const value = await waiting
  assert.equal(value.status, 'answered')
  assert.deepEqual(value.answers.map(item => item.id), ['q1', 'q2'])
  // The mode is still waiting for its requirement card.
  assert.equal(harness.sectionTextFor(agent()), PROTOCOL)
})

test('skipping the interview through the route lets work start on defaults', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const waiting = harness.tool('clarify_ask').execute({
    questions: [{ question: '要几页？', options: [{ label: '8 页' }] }],
  }, { agent: agent(), callId: 'c1' })
  const pending = await waitPending(harness)

  const cancelled = await harness.call(CANCEL, post({ session: 'session-1', id: pending.id, reason: 'skipped' }))
  assert.equal(cancelled.status, 200)
  assert.equal((await waiting).status, 'skipped')
})

test('the review goes through the same panel and approval stores the card', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const waiting = harness.tool('clarify_brief').execute(
    { brief: '# 需求卡\n- 目标：8 页预习报告' },
    { agent: agent(), callId: 'c1' },
  )
  const pending = await waitPending(harness)
  assert.equal(pending.kind, 'review')
  assert.ok(pending.detail.includes('# 需求卡'))
  assert.deepEqual(pending.options.map(option => option.label), ['确认开工', '还要再问', '我自己改'])

  await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [{ id: 'review', selected: ['确认开工'], custom: '' }],
  }))

  const value = await waiting
  assert.equal(value.action, 'approved')
  const section = harness.sectionTextFor(agent())
  assert.ok(section.includes('需求已确认'))
  assert.ok(section.includes('8 页预习报告'))
})

test('an approval writes the card into the workspace and hands the model its path', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-workspace-'))
  const harness = await boot()
  const { value } = await approveCard(harness, { agent: agent('session-1', cwd) })

  assert.equal(value.action, 'approved')
  const dir = path.join(cwd, '.dsh', 'clarify')
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  assert.ok(names[0].startsWith('card-'))
  assert.ok(names[0].endsWith('-需求卡.md'))
  const file = path.join(dir, names[0])
  assert.ok((await readFile(file, 'utf8')).includes('8 页预习报告'))
  assert.equal(value.cardPath, file)

  // The model is told where the card landed, in the render it actually reads.
  const rendered = harness.tool('clarify_brief').output.render({ brief: '# 需求卡' }, value)[0].text
  assert.ok(rendered.includes('需求卡已落盘：'))
  assert.ok(rendered.includes(file))
})

test('an approval adds one entry to cards.json next to state.json', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-archive-'))
  await writeFile(path.join(directory, 'cards.json'), `${JSON.stringify({
    version: 1,
    cards: [{ id: 'older', card: '# 上一张卡', title: '上一张卡', approvedAt: 1, sessionId: 's0' }],
  })}\n`, 'utf8')

  const harness = await boot({ directory })
  const { value } = await approveCard(harness)
  assert.equal(value.action, 'approved')

  const document = JSON.parse(await readFile(path.join(directory, 'cards.json'), 'utf8'))
  assert.equal(document.version, 1)
  // Newest first, and the seeded card was not overwritten.
  assert.deepEqual(document.cards.map(entry => entry.title), ['需求卡', '上一张卡'])
  assert.equal((await harness.call(HEALTH)).json.cards, 2)
})

test('cardFile:false remembers the approval but writes no file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-workspace-'))
  const harness = await boot({ config: { cardFile: false } })
  const { value } = await approveCard(harness, { agent: agent('session-1', cwd) })

  assert.equal(value.action, 'approved')
  assert.equal(value.cardPath, '')
  await assert.rejects(
    readdir(path.join(cwd, '.dsh', 'clarify')),
    error => error.code === 'ENOENT',
  )

  const document = JSON.parse(await readFile(path.join(harness.directory, 'cards.json'), 'utf8'))
  assert.equal(document.cards.length, 1)
  assert.equal(document.cards[0].card, '# 需求卡\n- 目标：8 页预习报告')
})

test('a failed card write is a warning, never a failed approval', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-blocked-'))
  const blocker = path.join(cwd, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  const harness = await boot({ config: { cardFileDir: path.join(blocker, 'cards') } })
  const { value } = await approveCard(harness, { agent: agent('session-1', cwd) })

  // The decision stands: only the file conveniences are lost.
  assert.equal(value.approved, true)
  assert.equal(value.action, 'approved')
  assert.equal(value.cardPath, '')
  assert.ok(harness.state.warnings.some(warning => warning.includes('could not write the card file')))
  const document = JSON.parse(await readFile(path.join(harness.directory, 'cards.json'), 'utf8'))
  assert.equal(document.cards.length, 1)
})

test('the next interview gets a digest of the recently approved cards', async () => {
  const harness = await boot({ config: { defaultEnabled: true } })
  // Nothing approved yet: the intake script stays byte-for-byte the old one.
  assert.equal(harness.sectionTextFor(agent('fresh')), PROTOCOL)

  await approveCard(harness)

  const intake = harness.sectionTextFor(agent('fresh'))
  assert.ok(intake.startsWith(PROTOCOL))
  assert.ok(intake.includes('最近批准过的需求卡'))
  assert.ok(intake.includes('《需求卡》'))
  assert.ok(intake.includes('8 页预习报告'))
  assert.ok(!intake.includes('需求已确认'))

  // The session that approved reads the anchor, not the archive.
  const anchor = harness.sectionTextFor(agent())
  assert.ok(anchor.includes('需求已确认'))
  assert.ok(!anchor.includes('最近批准过的需求卡'))
})

test('impact-dropped questions reach the model through the tool note', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const waiting = harness.tool('clarify_ask').execute({
    questions: [
      { question: '要几页？', options: [{ label: '8 页' }] },
      { question: '你平时用哪个编辑器？', impact: 'nice-to-know' },
    ],
  }, { agent: agent(), callId: 'c1' })

  const pending = await waitPending(harness)
  // Only the question that changes the artifact reaches the person...
  assert.equal(pending.questions.length, 1)
  assert.equal(pending.note, '1 个问题不会改变产出，已丢弃')

  await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [{ id: pending.questions[0].id, selected: ['8 页'], custom: '' }],
  }))
  const value = await waiting
  assert.equal(value.status, 'answered')
  assert.equal(value.answers.length, 1)
  // ...and the tool result tells the model why, since the panel never showed it.
  assert.ok(value.note.includes('1 个问题不会改变产出，已丢弃'))
})

test('recentCardsDigest is bounded, truncated and empty-safe', () => {
  assert.equal(recentCardsDigest([]), '')
  assert.equal(recentCardsDigest(undefined), '')
  assert.equal(recentCardsDigest([{ card: '   ' }]), '')

  const cards = Array.from({ length: 4 }, (_, index) => ({
    title: `卡 ${index + 1}`,
    card: `正文 ${index + 1} ${'细'.repeat(400)}`,
    approvedAt: Date.UTC(2026, 0, index + 1),
  }))
  const digest = recentCardsDigest(cards)
  assert.ok(digest.startsWith('【最近批准过的需求卡'))
  assert.ok(digest.includes('《卡 1》'))
  assert.ok(!digest.includes('《卡 4》'))
  assert.equal(digest.split('\n').filter(line => line.startsWith('  ')).length, 3)
  // Each excerpt is capped at 300 code points.
  const excerpt = digest.split('\n').find(line => line.startsWith('  '))
  assert.equal(Array.from(excerpt.trim()).length, 300)
  assert.ok(digest.includes('2026-01-01'))

  const single = recentCardsDigest(cards, { max: 1, chars: 5 })
  assert.ok(single.includes('《卡 1》'))
  assert.ok(!single.includes('《卡 2》'))
  const shortExcerpt = single.split('\n').find(line => line.startsWith('  '))
  assert.ok(Array.from(shortExcerpt.trim()).length <= 5)
})

test('without a panel the plugin degrades to no_client instead of hanging', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  const value = await harness.tool('clarify_ask').execute(
    { questions: [{ question: '要几页？' }] },
    { agent: agent(), callId: 'c1' },
  )
  assert.equal(value.status, 'no_client')
  assert.equal(value.answers.length, 0)
})

test('the fallback still works when a built-in question channel exists', async () => {
  const asked = []
  const harness = await boot({
    userQuestions: {
      async ask(request) {
        asked.push(request)
        return { answers: [{ id: request.questions[0].id, selected: ['8 页'], custom: '' }] }
      },
    },
  })
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  const value = await harness.tool('clarify_ask').execute({
    questions: [
      { question: '要几页？', options: [{ label: '8 页' }] },
      { question: '给谁看？', options: [{ label: '老师' }] },
    ],
  }, { agent: agent(), callId: 'c1' })
  assert.equal(value.status, 'answered')
  // One question per call: the built-in UI has a single answer box.
  assert.equal(asked.length, 2)
  assert.equal(asked[0].questions.length, 1)
})

test('the pending route doubles as the panel heartbeat', async () => {
  const harness = await boot()
  const before = await harness.call(HEALTH)
  assert.equal(before.json.pending, 0)

  const empty = await harness.call(PENDING, { url: `${PENDING}?session=session-1` })
  assert.equal(empty.json.pending, null)
  assert.equal(empty.json.enabled, false)
  assert.equal(empty.json.approved, false)
})

test('answer and cancel reject unknown ids instead of pretending', async () => {
  const harness = await boot()
  const answer = await harness.call(ANSWER, post({ session: 's', id: 'ask-nope', answers: [] }))
  assert.equal(answer.status, 409)
  const cancel = await harness.call(CANCEL, post({ session: 's', id: 'ask-nope' }))
  assert.equal(cancel.status, 409)
  const badBody = await harness.call(ANSWER, post({ session: 's', id: 'ask-nope', answers: 'nope' }))
  assert.equal(badBody.status, 400)
})

test('a deployment default turns new sessions on without a click', async () => {
  const harness = await boot({ config: { defaultEnabled: true } })
  assert.equal(harness.sectionTextFor(agent()), PROTOCOL)
  assert.equal(harness.sectionTextFor(agent('brand-new')), PROTOCOL)

  const off = await harness.call(TOGGLE, post({ session: 'session-1', enabled: false }))
  assert.equal(off.json.enabled, false)
  assert.equal(harness.sectionTextFor(agent()), '')
  assert.equal(harness.sectionTextFor(agent('brand-new')), PROTOCOL)
})

test('toggling through the route changes what the model reads on the next request', async () => {
  const harness = await boot()
  assert.equal(harness.sectionTextFor(agent()), '')

  const toggled = await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  assert.equal(toggled.status, 200)
  assert.equal(toggled.json.enabled, true)

  assert.equal(harness.sectionTextFor(agent()), PROTOCOL)
  assert.equal(harness.sectionTextFor(agent('session-2')), '')
})

test('/clarify on, off and status agree with the pill', async () => {
  const harness = await boot()
  const command = harness.state.commands[0]
  const run = rawInput => command.handler({ agent: agent(), rawInput, attachments: [] })

  assert.ok((await run('status')).text.includes('关'))
  assert.ok((await run('on')).text.includes('开'))
  assert.equal(harness.sectionTextFor(agent()), PROTOCOL)
  assert.ok((await run('status')).text.includes('开'))
  assert.ok((await run('off')).text.includes('关'))
  assert.equal(harness.sectionTextFor(agent()), '')
  assert.equal((await run('nonsense')).kind, 'error')
  assert.ok((await run('')).text.includes('开'))
})

test('the state route reports the pill what the store holds', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  const state = await harness.call(STATE, { url: `${STATE}?session=session-1` })
  assert.equal(state.status, 200)
  assert.deepEqual(state.json, {
    ok: true,
    session: 'session-1',
    enabled: true,
    approved: false,
    brief: '',
    approvedAt: null,
  })
})

test('clearing the card starts a new intake', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })
  const waiting = harness.tool('clarify_brief').execute({ brief: '# 卡' }, { agent: agent(), callId: 'c1' })
  const pending = await waitPending(harness)
  await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [{ id: 'review', selected: ['确认开工'], custom: '' }],
  }))
  await waiting
  assert.ok(harness.sectionTextFor(agent()).includes('需求已确认'))

  const cleared = await harness.call(CLEAR, post({ session: 'session-1' }))
  assert.deepEqual(cleared.json, {
    ok: true,
    session: 'session-1',
    enabled: true,
    approved: false,
    brief: '',
    approvedAt: null,
  })
  // Intake restarts. The card approved a moment ago is now archive, so the
  // script carries the digest too — but it is still the intake script.
  const intake = harness.sectionTextFor(agent())
  assert.ok(intake.startsWith(PROTOCOL))
  assert.ok(intake.includes('最近批准过的需求卡'))
})

test('the routes refuse cross-site writes, wrong methods and empty sessions', async () => {
  const harness = await boot()
  const crossSite = await harness.call(TOGGLE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:3042' },
    body: JSON.stringify({ session: 's', enabled: true }),
  })
  assert.equal(crossSite.status, 403)

  const wrongMethod = await harness.call(STATE, { method: 'POST', body: '{}' })
  assert.equal(wrongMethod.status, 405)

  const empty = await harness.call(TOGGLE, post({ enabled: true }))
  assert.equal(empty.status, 400)

  const missingSession = await harness.call(PENDING)
  assert.equal(missingSession.status, 400)

  const broken = await harness.call(TOGGLE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  })
  assert.equal(broken.status, 400)
})

test('the waiting list names the session that is blocked, and does not fake presence', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })
  const waitingTool = harness.tool('clarify_ask').execute(
    { questions: [{ question: '要几页？' }, { question: '给谁看？' }] },
    { agent: agent(), callId: 'c1' },
  )
  const pending = await waitPending(harness)

  const waiting = await harness.call(WAITING)
  assert.equal(waiting.json.sessions.length, 1)
  assert.equal(waiting.json.sessions[0].session, 'session-1')
  assert.equal(waiting.json.sessions[0].count, 2)

  await harness.call(CANCEL, post({ session: 'session-1', id: pending.id, reason: 'skipped' }))
  await waitingTool
  assert.deepEqual((await harness.call(WAITING)).json.sessions, [])
})

test('the host connection fence decides, and a local script keeps its carve-out', async () => {
  const connection = {
    requestRejection(request) {
      return request.headers['x-anon'] === '1' ? 401 : undefined
    },
  }
  const harness = await boot({ connection })
  const browserish = await harness.call(STATE, {
    url: `${STATE}?session=s`,
    headers: { 'x-anon': '1', cookie: 'dsh=abc', origin: 'http://127.0.0.1:3042' },
  })
  assert.equal(browserish.status, 401)

  // A local script has no cookie and no Origin: the loopback rule judges it.
  const localScript = await harness.call(STATE, { url: `${STATE}?session=s`, headers: { 'x-anon': '1' } })
  assert.equal(localScript.status, 200)

  // The fence says nothing and the caller is authenticated: allowed.
  const trusted = await harness.call(STATE, {
    url: `${STATE}?session=s`,
    headers: { cookie: 'dsh=abc', origin: 'http://127.0.0.1:3042' },
  })
  assert.equal(trusted.status, 200)
})

test('without a connection fence, a non-loopback caller is refused', async () => {
  const harness = await boot()
  const remote = await harness.call(STATE, { url: `${STATE}?session=s`, remoteAddress: '10.1.2.3' })
  assert.equal(remote.status, 403)
  const local = await harness.call(STATE, { url: `${STATE}?session=s` })
  assert.equal(local.status, 200)
})

test('health names every registered surface', async () => {
  const harness = await boot()
  const health = await harness.call(HEALTH)
  assert.equal(health.json.version, VERSION)
  assert.deepEqual(health.json.surfaces, { section: true, tools: true, routes: 8, commands: true, error: '' })
  assert.ok(health.json.file.endsWith('state.json'))
  assert.equal(health.json.pending, 0)
  assert.equal(health.json.cards, 0)
  assert.equal(health.json.interviews, 0)
})

test('a lean composition loads: every surface is optional', async () => {
  for (const omit of [['systemPrompt'], ['tools'], ['webServer'], ['commands']]) {
    const harness = await boot({ omit })
    assert.ok(harness.state.warnings.every(warning => !warning.includes('not registered')), omit.join())
    assert.equal(harness.state.sections.length, omit.includes('systemPrompt') ? 0 : 1)
    assert.equal(harness.state.tools.length, omit.includes('tools') ? 0 : 2)
    assert.equal(harness.state.routes.length, omit.includes('webServer') ? 0 : 8)
    assert.equal(harness.state.commands.length, omit.includes('commands') ? 0 : 1)
  }
})

test('config is validated without taking boot down', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
  assert.equal(resolveConfig({ sectionOrder: 9000 }).sectionOrder, 9000)
  assert.equal(resolveConfig({ sectionOrder: 'x' }).sectionOrder, DEFAULTS.sectionOrder)
  assert.equal(resolveConfig({ guidance: false }).guidance, false)
  assert.equal(resolveConfig({ defaultEnabled: true }).defaultEnabled, true)
  assert.equal(resolveConfig({ interviewTimeoutMs: 5000 }).interviewTimeoutMs, 5000)
  assert.equal(resolveConfig({ interviewTimeoutMs: -1 }).interviewTimeoutMs, DEFAULTS.interviewTimeoutMs)
  assert.equal(resolveConfig({}).cardFile, true)
  assert.equal(resolveConfig({ cardFile: false }).cardFile, false)
  // Only an explicit false disables the write.
  assert.equal(resolveConfig({ cardFile: 'no' }).cardFile, true)
  assert.equal(resolveConfig({ cardFileDir: '  /tmp/cards  ' }).cardFileDir, '/tmp/cards')
  assert.equal(resolveConfig({ cardFileDir: 42 }).cardFileDir, '')
  assert.equal(resolveConfig({}).interviewMode, 'full')
  assert.equal(resolveConfig({ interviewMode: 'quick' }).interviewMode, 'quick')
  assert.equal(resolveConfig({ interviewMode: ' QUICK ' }).interviewMode, 'quick')
  // Anything that is not exactly quick stays on the full interview.
  assert.equal(resolveConfig({ interviewMode: 'nonsense' }).interviewMode, 'full')
  assert.equal(resolveConfig({ interviewMode: true }).interviewMode, 'full')
  const warnings = []
  resolveConfig({ typo: 1 }, { warn: message => warnings.push(message) })
  assert.ok(warnings[0].includes('typo'))
})

test('describe never claims an approval the store does not have', () => {
  assert.ok(describe({ enabled: false, approved: true }).includes('关'))
  assert.ok(describe({ enabled: true, approved: false }).includes('下一轮'))
  assert.ok(describe({ enabled: true, approved: true }).includes('已确认'))
})

test('the work tracker only counts file-writing tools', () => {
  const tracker = createWorkTracker()
  assert.equal(tracker.hasStartedWork('s1'), false)
  // Reading, planning and chatting never mean work started.
  tracker.observe({ id: 's1' }, { type: 'tool/call', data: { name: 'read' } })
  tracker.observe({ id: 's1' }, { type: 'assistant/message', data: {} })
  assert.equal(tracker.hasStartedWork('s1'), false)

  for (const name of WRITE_TOOLS) {
    const id = `session-${name}`
    assert.equal(tracker.observe({ id }, { type: 'tool/call', data: { name } }), true)
    assert.equal(tracker.hasStartedWork(id), true)
  }
  // A session id passed as a bare string works too, and junk is ignored.
  assert.equal(tracker.observe('bare', { type: 'tool/call', data: { name: 'edit' } }), true)
  assert.equal(tracker.hasStartedWork('bare'), true)
  assert.equal(tracker.observe(undefined, undefined), false)
  assert.equal(tracker.observe('s', { type: 'tool/call', data: {} }), false)
  assert.equal(tracker.hasStartedWork(''), false)

  tracker.reset()
  assert.equal(tracker.hasStartedWork('s1'), false)
})

test('goal questions survive intake and are dropped once the session has written', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const args = {
    questions: [
      { header: '目标', question: '到底要什么？', kind: 'goal' },
      { header: '格式', question: '要什么格式？' },
    ],
  }
  const first = harness.tool('clarify_ask').execute(args, { agent: agent(), callId: 'c1' })
  const pending = await waitPending(harness)
  // Before any writing tool, a goal question is still legitimate.
  assert.deepEqual(pending.questions.map(question => question.kind), ['goal', 'input'])
  await harness.call(CANCEL, post({ session: 'session-1', id: pending.id, reason: 'skipped' }))
  await first

  // A read is not work; a write is, and the stale goal question is dropped.
  harness.emit('session/event', { id: 'session-1' }, { type: 'tool/call', data: { name: 'read' } })
  harness.emit('session/event', { id: 'session-1' }, { type: 'tool/call', data: { name: 'write' } })

  const second = harness.tool('clarify_ask').execute(args, { agent: agent(), callId: 'c2' })
  const next = await waitPending(harness)
  assert.deepEqual(next.questions.map(question => question.question), ['要什么格式？'])
  assert.ok(next.note.includes('goal 类问题已过期'))
  await harness.call(ANSWER, post({
    session: 'session-1',
    id: next.id,
    answers: [{ id: 'q1', selected: ['A'], custom: '' }],
  }))
  const value = await second
  assert.equal(value.status, 'answered')
  assert.ok(value.note.includes('会话已经开始动手，goal 类问题已过期，已丢弃 1 题'))
})

test('an ask records one interview metric and health reports the count', async () => {
  const harness = await boot()
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })
  assert.equal((await harness.call(HEALTH)).json.interviews, 0)

  const waiting = harness.tool('clarify_ask').execute({
    questions: [
      { question: '要几页？' },
      { question: '你平时用哪个编辑器？', impact: 'nice-to-know' },
    ],
  }, { agent: agent(), callId: 'c1' })
  const pending = await waitPending(harness)
  await harness.call(ANSWER, post({
    session: 'session-1',
    id: pending.id,
    answers: [{ id: 'q1', selected: ['8 页'], custom: '' }],
  }))
  assert.equal((await waiting).status, 'answered')

  assert.equal((await harness.call(HEALTH)).json.interviews, 1)
  const document = JSON.parse(await readFile(path.join(harness.directory, 'metrics.json'), 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.entries.length, 1)
  const [entry] = document.entries
  assert.equal(entry.kind, 'questions')
  assert.equal(entry.status, 'answered')
  assert.equal(entry.asked, 1)
  assert.equal(entry.dropped, 1)
  assert.equal(entry.sessionId, 'session-1')
  assert.ok(Number.isFinite(entry.ms))
})

test('the configured quick mode narrows the panel and carries mode plus focus', async () => {
  const harness = await boot({ config: { interviewMode: 'quick' } })
  await harness.call(TOGGLE, post({ session: 'session-1', enabled: true }))
  await harness.call(PENDING, { url: `${PENDING}?session=session-1` })

  const waiting = harness.tool('clarify_ask').execute({
    focus: '格式',
    questions: [
      { header: '字体', question: '用什么字体？' },
      { header: '字号', question: '用多大字号？' },
    ],
  }, { agent: agent(), callId: 'c1' })
  const pending = await waitPending(harness)
  assert.equal(pending.mode, 'quick')
  assert.equal(pending.focus, '格式')
  assert.equal(pending.questions.length, 1)
  assert.equal(pending.questions[0].question, '用什么字体？')
  await harness.call(CANCEL, post({ session: 'session-1', id: pending.id, reason: 'skipped' }))
  assert.equal((await waiting).status, 'skipped')
})

test('a checklist lands in the approved card, the anchor and the card file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-checklist-'))
  const harness = await boot()
  const { value, pending } = await approveCard(harness, {
    agent: agent('session-1', cwd),
    extra: { checklist: ['PDF 能打开', '页数正确'] },
  })

  assert.equal(value.action, 'approved')
  // The person sees the checklist before approving.
  assert.ok(pending.detail.includes('**验收清单**'))
  assert.ok(pending.detail.includes('- [ ] PDF 能打开'))

  const dir = path.join(cwd, '.dsh', 'clarify')
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  const text = await readFile(path.join(dir, names[0]), 'utf8')
  assert.ok(text.includes('**验收清单**'))
  assert.ok(text.includes('- [ ] PDF 能打开'))
  assert.ok(text.includes('- [ ] 页数正确'))

  // The approved anchor pastes the checklist back on every turn.
  const anchor = harness.sectionTextFor(agent())
  assert.ok(anchor.includes('**验收清单**'))
  assert.ok(anchor.includes('- [ ] 页数正确'))

  // The review itself is recorded as one answered question.
  const document = JSON.parse(await readFile(path.join(harness.directory, 'metrics.json'), 'utf8'))
  assert.equal(document.entries.length, 1)
  assert.equal(document.entries[0].kind, 'review')
  assert.equal(document.entries[0].status, 'answered')
  assert.equal(document.entries[0].asked, 1)
})

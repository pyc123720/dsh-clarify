import assert from 'node:assert/strict'
import test from 'node:test'

import { createInterview } from '../lib/interview.js'

test('a pending interview is visible, then settles exactly once', async () => {
  const interview = createInterview()
  const waiting = interview.ask('s1', { kind: 'questions', payload: { intro: '确认三件事', questions: [{ id: 'q1', question: '几页？' }] } })
  const view = interview.pendingView('s1')
  assert.equal(view.kind, 'questions')
  assert.equal(view.questions[0].question, '几页？')
  assert.equal(interview.stats().pending, 1)

  assert.equal(interview.answer('s1', view.id, [{ id: 'q1', selected: ['8 页'], custom: '' }]), true)
  const result = await waiting
  assert.equal(result.status, 'answered')
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['8 页'], custom: '' }])

  // A second answer for the same call is refused, not silently accepted.
  assert.equal(interview.answer('s1', view.id, []), false)
  assert.equal(interview.pendingView('s1'), null)
})

test('one session cannot have two open interviews', async () => {
  const interview = createInterview()
  const first = interview.ask('s1', { kind: 'questions', payload: { questions: [] } })
  const second = await interview.ask('s1', { kind: 'questions', payload: { questions: [] } })
  assert.equal(second.status, 'busy')
  interview.cancel('s1', undefined, 'dismissed')
  assert.equal((await first).status, 'dismissed')
})

test('a stale pending id cannot settle someone else\'s question', async () => {
  const interview = createInterview()
  const waiting = interview.ask('s1', { kind: 'questions', payload: { questions: [] } })
  assert.equal(interview.answer('s1', 'ask-nope', []), false)
  assert.equal(interview.cancel('s1', 'ask-nope'), false)
  interview.cancel('s1', undefined, 'skipped')
  assert.equal((await waiting).status, 'skipped')
})

test('an unanswered interview times out instead of hanging', async () => {
  const interview = createInterview({ timeoutMs: 20 })
  const result = await interview.ask('s1', { kind: 'questions', payload: { questions: [] } })
  assert.equal(result.status, 'timeout')
  assert.equal(interview.pendingView('s1'), null)
})

test('unloading settles every open interview', async () => {
  const interview = createInterview()
  const a = interview.ask('s1', { kind: 'questions', payload: { questions: [] } })
  const b = interview.ask('s2', { kind: 'review', payload: { detail: '卡' } })
  interview.closeAll('unloaded')
  assert.equal((await a).status, 'unloaded')
  assert.equal((await b).status, 'unloaded')
  assert.equal(interview.stats().pending, 0)
})

test('client presence comes from the panel heartbeat and expires', () => {
  let clock = 1000
  const interview = createInterview({ now: () => clock, graceMs: 100 })
  assert.equal(interview.clientAlive('s1'), false)
  interview.touch('s1')
  assert.equal(interview.clientAlive('s1'), true)
  clock += 101
  assert.equal(interview.clientAlive('s1'), false)
  assert.equal(interview.clientAlive(''), false)
})

test('list() names every session waiting, without touching presence', async () => {
  const interview = createInterview()
  const a = interview.ask('s1', { kind: 'questions', payload: { questions: [{}, {}] } })
  const b = interview.ask('s2', { kind: 'review', payload: { detail: '卡' } })
  const listed = interview.list()
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map(entry => entry.session).sort(), ['s1', 's2'])
  assert.equal(listed.find(entry => entry.session === 's1').count, 2)
  assert.equal(listed.find(entry => entry.session === 's2').count, 1)
  assert.equal(interview.clientAlive('s1'), false)
  interview.closeAll('unloaded')
  await a
  await b
})

test('an empty session id never blocks a call', async () => {
  const interview = createInterview()
  const result = await interview.ask('', { kind: 'questions', payload: {} })
  assert.equal(result.status, 'unloaded')
  assert.equal(interview.stats().pending, 0)
})

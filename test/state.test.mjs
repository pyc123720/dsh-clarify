import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStateStore, normalizeEntry, resolveStatePath } from '../lib/state.js'

async function storeAt(file, options = {}) {
  const store = createStateStore({ file, ...options })
  await store.load()
  return store
}

test('state survives a reload, keyed by session', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const file = path.join(directory, 'state.json')

  const first = await storeAt(file)
  await first.setEnabled('session-a', true)
  await first.approve('session-a', '# 需求卡\n目标：报告')
  await first.setEnabled('session-b', true)
  await first.flush()

  const second = await storeAt(file)
  assert.deepEqual(second.view('session-a').enabled, true)
  assert.deepEqual(second.view('session-a').approved, true)
  assert.equal(second.view('session-a').brief, '# 需求卡\n目标：报告')
  assert.equal(second.view('session-b').enabled, true)
  assert.equal(second.view('session-b').approved, false)
  assert.equal(second.view('unknown').enabled, false)
})

test('clearing a card keeps the mode on and removes the approval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const store = await storeAt(path.join(directory, 'state.json'))
  await store.setEnabled('s', true)
  await store.approve('s', '# 卡')
  await store.clearBrief('s')
  assert.deepEqual(store.view('s'), { enabled: true, approved: false, brief: '', approvedAt: null })
})

test('a deployment default applies until a session makes an explicit choice', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const store = await storeAt(path.join(directory, 'state.json'), { defaultEnabled: true })
  assert.equal(store.view('fresh').enabled, true)
  await store.setEnabled('fresh', false)
  assert.equal(store.view('fresh').enabled, false)
  // A different session still follows the default.
  assert.equal(store.view('other').enabled, true)
  // And an explicit choice is what gets persisted.
  await store.flush()
  const reloaded = await storeAt(path.join(directory, 'state.json'), { defaultEnabled: true })
  assert.equal(reloaded.view('fresh').enabled, false)
})

test('reads never create a row', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const store = await storeAt(path.join(directory, 'state.json'))
  store.get('nobody')
  store.view('nobody')
  assert.deepEqual(store.stats(), { sessions: 0, enabled: 0 })
})

test('an empty session id is inert instead of throwing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const store = await storeAt(path.join(directory, 'state.json'))
  await store.setEnabled('', true)
  await store.approve('', '# 卡')
  assert.equal(store.view('').enabled, false)
  assert.deepEqual(store.stats(), { sessions: 0, enabled: 0 })
})

test('unreadable rows degrade to empty rows instead of failing the file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const file = path.join(directory, 'state.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    sessions: {
      broken: 'not an object',
      weird: { enabled: 'yes', brief: 7, approvedAt: 'x' },
      ok: { enabled: true, brief: '# 卡', approvedAt: 12 },
    },
  }), 'utf8')

  const store = await storeAt(file)
  assert.deepEqual(store.view('broken').enabled, false)
  assert.deepEqual(store.view('weird').enabled, false)
  assert.deepEqual(store.view('weird').brief, '')
  assert.equal(store.view('ok').approved, true)
})

test('invalid JSON is survivable and the file is left alone', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  const file = path.join(directory, 'state.json')
  await writeFile(file, '{ not json', 'utf8')
  const store = await storeAt(file)
  assert.equal(store.view('anything').enabled, false)
  await store.setEnabled('s', true)
  await store.flush()
  const text = await readFile(file, 'utf8')
  assert.equal(JSON.parse(text).sessions.s.enabled, true)
})

test('old rows are pruned, newest survive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-'))
  let clock = 1
  const store = await storeAt(path.join(directory, 'state.json'), {
    maxSessions: 3,
    now: () => clock++,
  })
  for (const id of ['a', 'b', 'c', 'd']) await store.setEnabled(id, true)
  assert.equal(store.stats().sessions, 3)
  assert.equal(store.view('a').enabled, false)
  assert.equal(store.view('d').enabled, true)
})

test('normalizeEntry keeps a card without a stamp but never the claim', () => {
  assert.deepEqual(normalizeEntry({ enabled: true, brief: '# 卡' }), {
    enabled: true,
    brief: '# 卡',
    approvedAt: null,
    updatedAt: 0,
  })
  assert.deepEqual(normalizeEntry(null), { enabled: false, brief: '', approvedAt: null, updatedAt: 0 })
})

test('the store path honours DSH_HOME and an explicit override', () => {
  assert.equal(
    resolveStatePath({}, { DSH_HOME: '/tmp/dsh-home' }).replaceAll('\\', '/'),
    path.join('/tmp/dsh-home', 'clarify', 'state.json').replaceAll('\\', '/'),
  )
  assert.equal(
    resolveStatePath({ storePath: '/tmp/custom.json' }, {}).replaceAll('\\', '/'),
    path.resolve('/tmp/custom.json').replaceAll('\\', '/'),
  )
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createPreferences,
  deriveTitle,
  normalizeCard,
  resolvePreferencesPath,
} from '../lib/preferences.js'

/** A store over a fresh file in a fresh directory, already loaded. */
async function prefsAt(file, options = {}) {
  const prefs = createPreferences({ file, ...options })
  await prefs.load()
  return prefs
}

async function tempFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-prefs-'))
  return path.join(directory, 'preferences.json')
}

test('approved cards survive a reload, newest first', async () => {
  const file = await tempFile()
  let clock = 1_000
  const first = await prefsAt(file, { now: () => clock++ })

  await first.remember({ card: '# 周报\n目标：三月周报', sessionId: 'session-a' })
  await first.remember({ card: '# 答辩稿\n目标：毕设答辩', sessionId: 'session-b' })
  assert.deepEqual(first.list().map(entry => entry.title), ['答辩稿', '周报'])

  const second = await prefsAt(file)
  assert.equal(second.list().length, 2)
  assert.deepEqual(second.list().map(entry => entry.title), ['答辩稿', '周报'])
  const newest = second.list()[0]
  assert.equal(newest.card, '# 答辩稿\n目标：毕设答辩')
  assert.equal(newest.sessionId, 'session-b')
  assert.equal(newest.approvedAt, 1_001)
  assert.ok(typeof newest.id === 'string' && newest.id !== '')
  assert.deepEqual(second.stats(), { count: 2 })
})

test('re-approving the same card moves it to the front and keeps its id', async () => {
  const file = await tempFile()
  let clock = 10
  const prefs = await prefsAt(file, { now: () => clock++ })

  const older = await prefs.remember({ card: '# 甲的卡', sessionId: 's1' })
  await prefs.remember({ card: '# 乙的卡' })
  // Outer whitespace is not a different card.
  const again = await prefs.remember({ card: '  # 甲的卡\n', sessionId: 's2' })

  assert.equal(prefs.list().length, 2)
  assert.equal(again.id, older.id)
  assert.equal(prefs.list()[0].id, older.id)
  assert.equal(prefs.list()[0].title, '甲的卡')
  assert.equal(prefs.list()[0].card, '# 甲的卡')
  assert.equal(prefs.list()[0].sessionId, 's2')
  assert.ok(prefs.list()[0].approvedAt > older.approvedAt)

  const reloaded = await prefsAt(file)
  assert.equal(reloaded.list().length, 2)
  assert.equal(reloaded.list()[0].id, older.id)
})

test('a re-approval without a session keeps the one that first approved', async () => {
  const file = await tempFile()
  const prefs = await prefsAt(file)
  await prefs.remember({ card: '# 卡', sessionId: 'keep-me' })
  const again = await prefs.remember({ card: '# 卡' })
  assert.equal(again.sessionId, 'keep-me')
})

test('only the newest maxCards cards are kept', async () => {
  const file = await tempFile()
  let clock = 1
  const prefs = await prefsAt(file, { maxCards: 3, now: () => clock++ })

  for (const name of ['a', 'b', 'c', 'd']) await prefs.remember({ card: `# 卡${name}` })

  assert.equal(prefs.stats().count, 3)
  assert.deepEqual(prefs.list().map(entry => entry.title), ['卡d', '卡c', '卡b'])

  const reloaded = await prefsAt(file, { maxCards: 3 })
  assert.deepEqual(reloaded.list().map(entry => entry.title), ['卡d', '卡c', '卡b'])
})

test('a blank card is not remembered and never touches the disk', async () => {
  const file = await tempFile()
  const prefs = await prefsAt(file)

  assert.equal(await prefs.remember({ card: '   ' }), null)
  assert.equal(await prefs.remember({ card: '' }), null)
  assert.equal(await prefs.remember({ card: null }), null)
  assert.equal(await prefs.remember({ card: 42 }), null)
  assert.equal(await prefs.remember({}), null)
  assert.equal(await prefs.remember(), null)

  assert.deepEqual(prefs.stats(), { count: 0 })
  await assert.rejects(readFile(file, 'utf8'), error => error.code === 'ENOENT')
})

test('a missing file is an empty archive, not an error', async () => {
  const file = await tempFile()
  const prefs = await prefsAt(file)
  assert.deepEqual(prefs.list(), [])
  // And the very next approval creates the document.
  await prefs.remember({ card: '# 第一张卡' })
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.cards.length, 1)
})

test('a corrupt file reads as no memory and is left untouched', async () => {
  const file = await tempFile()
  await writeFile(file, '{ not json', 'utf8')

  const prefs = await prefsAt(file)
  assert.deepEqual(prefs.list(), [])
  assert.equal(await readFile(file, 'utf8'), '{ not json')

  // The next approval replaces the damaged document with valid JSON.
  await prefs.remember({ card: '# 新卡' })
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.cards.map(entry => entry.title), ['新卡'])
})

test('damaged rows are dropped and usable rows salvaged', async () => {
  const file = await tempFile()
  await writeFile(file, JSON.stringify({
    version: 99,
    cards: [
      'not an object',
      { title: 'no card text' },
      { id: 'kept', card: '# 真好卡', title: '', approvedAt: 5, sessionId: 's' },
    ],
  }), 'utf8')

  const prefs = await prefsAt(file)
  assert.equal(prefs.list().length, 1)
  assert.equal(prefs.list()[0].id, 'kept')
  assert.equal(prefs.list()[0].title, '真好卡')
  assert.equal(prefs.list()[0].approvedAt, 5)
})

test('a bare array of cards is readable too', async () => {
  const file = await tempFile()
  await writeFile(file, JSON.stringify([{ card: '# 数组卡' }]), 'utf8')
  const prefs = await prefsAt(file)
  assert.deepEqual(prefs.list().map(entry => entry.title), ['数组卡'])
})

test('remembering without load still preserves the archive on disk', async () => {
  const file = await tempFile()
  const seeded = await prefsAt(file)
  await seeded.remember({ card: '# 老卡' })

  // A caller that never loaded must not overwrite the existing file.
  const lazy = createPreferences({ file })
  await lazy.remember({ card: '# 新卡' })
  assert.deepEqual(lazy.list().map(entry => entry.title), ['新卡', '老卡'])

  const reloaded = await prefsAt(file)
  assert.equal(reloaded.stats().count, 2)
})

test('concurrent approvals all land, serialized into one file', async () => {
  const file = await tempFile()
  let clock = 1
  const prefs = await prefsAt(file, { now: () => clock++, maxCards: 12 })

  const entries = await Promise.all(Array.from({ length: 10 }, (_, index) => prefs.remember({
    card: `# 并发卡 ${index}`,
    sessionId: `s${index}`,
  })))

  assert.equal(entries.filter(Boolean).length, 10)
  assert.equal(prefs.stats().count, 10)
  assert.equal(new Set(entries.map(entry => entry.id)).size, 10)

  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.cards.length, 10)
  assert.equal(new Set(document.cards.map(entry => entry.id)).size, 10)
  // The in-memory order and the persisted order agree: nothing was lost or doubled.
  assert.deepEqual(document.cards.map(entry => entry.id), prefs.list().map(entry => entry.id))
})

test('clear empties the archive in memory and on disk', async () => {
  const file = await tempFile()
  const prefs = await prefsAt(file)
  await prefs.remember({ card: '# 卡一' })
  await prefs.remember({ card: '# 卡二' })

  await prefs.clear()
  assert.deepEqual(prefs.list(), [])
  assert.deepEqual(prefs.stats(), { count: 0 })

  const reloaded = await prefsAt(file)
  assert.deepEqual(reloaded.list(), [])
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.cards, [])
})

test('list hands out copies, so callers cannot reorder the archive', async () => {
  const file = await tempFile()
  const prefs = await prefsAt(file)
  await prefs.remember({ card: '# 旧' })
  await prefs.remember({ card: '# 新' })

  const handed = prefs.list()
  handed.reverse()
  handed[0].title = 'mutated'
  handed.push({ id: 'fake', title: 'fake', card: '# fake', approvedAt: 0, sessionId: '' })

  assert.deepEqual(prefs.list().map(entry => entry.title), ['新', '旧'])
})

test('titles come from an explicit name, the first heading, or the first line', () => {
  assert.equal(deriveTitle('# 三月周报\n目标：x', ''), '三月周报')
  assert.equal(deriveTitle('## 交付物\n目标：x'), '交付物')
  assert.equal(deriveTitle('**目标**：三月周报\n其余内容'), '目标：三月周报')
  assert.equal(deriveTitle('普通第一行\n# 后面的标题'), '后面的标题')
  assert.equal(deriveTitle('# 卡', '  自定义   标题  '), '自定义 标题')
  assert.equal(deriveTitle('- 列表里的第一行'), '列表里的第一行')
})

test('titles are capped at 60 characters, with a fallback for nameless cards', () => {
  const long = `# ${'很'.repeat(80)}`
  const title = deriveTitle(long)
  assert.equal(Array.from(title).length, 60)
  assert.equal(title, '很'.repeat(60))

  // A surrogate pair is never cut in half.
  const emoji = `# ${'😀'.repeat(70)}`
  assert.equal(Array.from(deriveTitle(emoji)).length, 60)

  assert.equal(deriveTitle(''), '需求卡')
  assert.equal(deriveTitle('   \n\n'), '需求卡')
  assert.equal(deriveTitle(), '需求卡')
  assert.equal(deriveTitle(null, ''), '需求卡')
})

test('normalizeCard drops a row without card text and names the rest', () => {
  assert.equal(normalizeCard(null), null)
  assert.equal(normalizeCard({ title: '没有卡' }), null)
  assert.equal(normalizeCard({ card: '  ' }), null)
  const kept = normalizeCard({ card: '正文', approvedAt: 'x' })
  assert.equal(kept.title, '正文')
  assert.equal(kept.approvedAt, 0)
  assert.equal(kept.sessionId, '')
  assert.ok(kept.id !== '')
})

test('the default path lives next to state.json', () => {
  assert.equal(
    resolvePreferencesPath({}, { DSH_HOME: '/tmp/dsh-home' }).replaceAll('\\', '/'),
    path.join('/tmp/dsh-home', 'clarify', 'preferences.json').replaceAll('\\', '/'),
  )
  assert.equal(
    resolvePreferencesPath({ file: '/tmp/custom-prefs.json' }, {}).replaceAll('\\', '/'),
    path.resolve('/tmp/custom-prefs.json').replaceAll('\\', '/'),
  )
})

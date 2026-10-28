import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CARD_TITLE,
  MAX_SLUG_CHARS,
  resolveCardDir,
  slugify,
  writeCard,
} from '../lib/card-file.js'

const FIXED = Date.UTC(2026, 9, 28, 13, 5, 7)

const clock = () => FIXED

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'dsh-clarify-card-'))
}

/** The same local minute the writer must put in the file name. */
function minuteStamp(ms) {
  const at = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}`
}

test('slugify keeps Chinese and turns spaces into single dashes', () => {
  assert.equal(slugify('需求卡'), '需求卡')
  assert.equal(slugify('季度 报告 2026'), '季度-报告-2026')
  assert.equal(slugify('  季度   报告  '), '季度-报告')
})

test('slugify strips what Windows refuses and every control character', () => {
  assert.equal(slugify('A<B>C:D"E/F\\G|H?I*J'), 'ABCDEFGHIJ')
  assert.equal(slugify('报告\u0000v1'), '报告v1')
  assert.equal(slugify('tab\there'), 'tabhere')
})

test('slugify falls back to brief when nothing survives', () => {
  assert.equal(slugify(''), 'brief')
  assert.equal(slugify('   '), 'brief')
  assert.equal(slugify('///'), 'brief')
  assert.equal(slugify('...'), 'brief')
  assert.equal(slugify(null), 'brief')
})

test('slugify truncates long fragments, by code point and at a custom limit', () => {
  assert.equal(slugify('a'.repeat(80)).length, MAX_SLUG_CHARS)
  assert.equal(slugify('需求'.repeat(40)).length, MAX_SLUG_CHARS)
  assert.equal(slugify('abcdef', 4), 'abcd')
  // An unusable limit falls back to the default instead of returning nothing.
  assert.equal(slugify('abc', 0), 'abc')
})

test('resolveCardDir prefers an explicit cardFileDir, resolved against the process', async () => {
  const root = await tempDir()
  const configured = path.join(root, 'shared', 'cards')
  assert.equal(
    resolveCardDir({ cwd: path.join(root, 'project'), config: { cardFileDir: configured } }),
    path.resolve(configured),
  )
})

test('resolveCardDir defaults to <cwd>/.dsh/clarify and needs a cwd', async () => {
  const root = await tempDir()
  assert.equal(resolveCardDir({ cwd: root, config: {} }), path.resolve(root, '.dsh', 'clarify'))
  // An all-whitespace override is no override.
  assert.equal(
    resolveCardDir({ cwd: root, config: { cardFileDir: '   ' } }),
    path.resolve(root, '.dsh', 'clarify'),
  )
  assert.equal(resolveCardDir({ cwd: '', config: {} }), '')
  assert.equal(resolveCardDir(), '')
})

test('writeCard writes the header and body and creates the directory', async () => {
  const root = await tempDir()
  const dir = path.join(root, 'nested', 'deep', '.dsh', 'clarify')
  const result = await writeCard({
    dir,
    // The body opens with the very heading the writer should hoist.
    card: '# 需求卡\n\n目标：季度报告',
    now: clock,
    sessionId: 'sess-abc',
  })
  const expected = '# 需求卡\n\n'
    + '- 批准时间：2026-10-28T13:05:07.000Z\n'
    + '- 会话：sess-abc\n\n'
    + '目标：季度报告\n'

  assert.equal(path.isAbsolute(result.path), true)
  assert.equal(path.dirname(result.path), dir)
  assert.equal(path.basename(result.path), `card-${minuteStamp(FIXED)}-需求卡.md`)
  assert.equal(await readFile(result.path, 'utf8'), expected)
  assert.equal(result.bytes, Buffer.byteLength(expected, 'utf8'))
  assert.equal((await stat(dir)).isDirectory(), true)
})

test('writeCard drops a leading heading that repeats the title and normalizes CRLF', async () => {
  const dir = path.join(await tempDir(), 'cards')
  const result = await writeCard({
    dir,
    card: '# 需求卡\r\n\r\n目标：x\r\n交付物：y',
    title: '需求卡',
    now: clock,
    sessionId: 's',
  })
  const text = await readFile(result.path, 'utf8')
  assert.equal((text.match(/^# 需求卡$/gm) ?? []).length, 1)
  assert.equal(
    text,
    '# 需求卡\n\n- 批准时间：2026-10-28T13:05:07.000Z\n- 会话：s\n\n目标：x\n交付物：y\n',
  )
})

test('an explicit title wins over the body heading', async () => {
  const dir = path.join(await tempDir(), 'cards')
  const result = await writeCard({
    dir,
    card: '目标：x',
    title: ' 上线 计划 ',
    now: clock,
    sessionId: 's',
  })
  assert.equal(path.basename(result.path), `card-${minuteStamp(FIXED)}-上线-计划.md`)
  const text = await readFile(result.path, 'utf8')
  assert.equal(text.split('\n')[0], '# 上线 计划')
  assert.equal(text.includes('目标：x'), true)
})

test('cards written in the same minute are suffixed -2 and -3', async () => {
  const dir = path.join(await tempDir(), 'cards')
  const card = '# 需求卡\n\n目标：x'
  const first = await writeCard({ dir, card, now: clock, sessionId: 's' })
  const second = await writeCard({ dir, card, now: clock, sessionId: 's' })
  const third = await writeCard({ dir, card, now: clock, sessionId: 's' })
  const stem = `card-${minuteStamp(FIXED)}-需求卡`
  assert.deepEqual(
    [first, second, third].map(written => path.basename(written.path)),
    [`${stem}.md`, `${stem}-2.md`, `${stem}-3.md`],
  )
})

test('an explicit approvedAt beats the clock', async () => {
  const approvedAt = Date.UTC(2026, 0, 2, 3, 4, 5)
  const result = await writeCard({
    dir: path.join(await tempDir(), 'cards'),
    card: '目标：x',
    approvedAt,
    now: () => {
      throw new Error('the clock must not be read')
    },
    sessionId: 's',
  })
  const text = await readFile(result.path, 'utf8')
  assert.equal(path.basename(result.path), `card-${minuteStamp(approvedAt)}-需求卡.md`)
  assert.equal(text.includes('- 批准时间：2026-01-02T03:04:05.000Z'), true)
})

test('a blank card throws', async () => {
  const dir = path.join(await tempDir(), 'cards')
  await assert.rejects(writeCard({ dir, card: '  \n\t ', now: clock }), /empty card/)
  await assert.rejects(writeCard({ dir, card: undefined, now: clock }), /empty card/)
})

test('a missing destination throws', async () => {
  await assert.rejects(writeCard({ dir: '   ', card: '# 需求卡', now: clock }), /empty card dir/)
  await assert.rejects(writeCard({ card: '# 需求卡', now: clock }), /empty card dir/)
})

test('a card with no heading and no title still gets the default title', async () => {
  const dir = path.join(await tempDir(), 'cards')
  const result = await writeCard({ dir, card: '目标：x\n交付物：y', now: clock, sessionId: 's' })
  assert.equal(
    path.basename(result.path),
    `card-${minuteStamp(FIXED)}-${DEFAULT_CARD_TITLE}.md`,
  )
  assert.equal(
    await readFile(result.path, 'utf8'),
    `# ${DEFAULT_CARD_TITLE}\n\n- 批准时间：2026-10-28T13:05:07.000Z\n- 会话：s\n\n目标：x\n交付物：y\n`,
  )
})

test('a missing session id is recorded instead of breaking the header', async () => {
  const dir = path.join(await tempDir(), 'cards')
  const result = await writeCard({ dir, card: '目标：x', now: clock })
  assert.equal((await readFile(result.path, 'utf8')).includes('- 会话：（无）'), true)
})

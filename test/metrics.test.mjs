import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createMetrics,
  normalizeStatus,
  resolveMetricsPath,
} from '../lib/metrics.js'
import { main, parseArgs, renderReport } from '../tools/stats.mjs'

/** A store over a fresh file in a fresh directory, already loaded. */
async function metricsAt(file, options = {}) {
  const metrics = createMetrics({ file, ...options })
  await metrics.load()
  return metrics
}

async function tempFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-clarify-metrics-'))
  return path.join(directory, 'metrics.json')
}

const EMPTY_SUMMARY = {
  interviews: 0,
  questions: 0,
  avgQuestions: 0,
  dropped: 0,
  dropRate: 0,
  answered: 0,
  dismissed: 0,
  skipped: 0,
  timeout: 0,
  noClient: 0,
  answerRate: 0,
  skipRate: 0,
  avgAnswerMs: 0,
}

test('summary counts every outcome and averages what it can', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)

  await metrics.record({ sessionId: 's1', asked: 2, dropped: 1, status: 'answered', ms: 1_000 })
  await metrics.record({ sessionId: 's1', asked: 1, dropped: 0, status: 'answered', ms: 3_000 })
  // A skipped interview's 9 seconds is not answer time and must not move the mean.
  await metrics.record({ asked: 3, dropped: 1, status: 'skipped', ms: 9_000 })
  await metrics.record({ asked: 2, dropped: 0, status: 'timeout', ms: 60_000 })
  await metrics.record({ asked: 1, dropped: 0, status: 'no_client' })
  await metrics.record({ asked: 1, dropped: 0, status: 'dismissed' })
  await metrics.record({ asked: 1, dropped: 0, status: 'off' })

  const expected = {
    interviews: 7,
    questions: 11,
    avgQuestions: 1.57,
    dropped: 2,
    dropRate: 0.1538,
    answered: 2,
    dismissed: 1,
    skipped: 1,
    timeout: 1,
    noClient: 1,
    answerRate: 0.2857,
    skipRate: 0.1429,
    avgAnswerMs: 2_000,
  }
  assert.deepEqual(metrics.summary(), expected)
  assert.deepEqual(metrics.stats(), { count: 7 })

  // And the same numbers come back from disk.
  const reloaded = await metricsAt(file)
  assert.deepEqual(reloaded.summary(), expected)
})

test('an empty archive summarizes to zeros', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)
  assert.deepEqual(metrics.summary(), EMPTY_SUMMARY)
  assert.deepEqual(metrics.stats(), { count: 0 })
})

test('only the newest maxEntries records are kept', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file, { maxEntries: 3 })

  for (const asked of [1, 2, 3, 4]) await metrics.record({ asked, status: 'skipped' })

  assert.deepEqual(metrics.stats(), { count: 3 })
  assert.equal(metrics.summary().interviews, 3)
  assert.equal(metrics.summary().questions, 9) // 2 + 3 + 4; the first record is gone.

  const reloaded = await metricsAt(file, { maxEntries: 3 })
  assert.equal(reloaded.stats().count, 3)
  assert.equal(reloaded.summary().questions, 9)
})

test('a corrupt file reads as no data and is left untouched', async () => {
  const file = await tempFile()
  await writeFile(file, '{ not json', 'utf8')

  const metrics = await metricsAt(file)
  assert.deepEqual(metrics.summary(), EMPTY_SUMMARY)
  assert.equal(await readFile(file, 'utf8'), '{ not json')

  // The next record replaces the damaged document with valid JSON.
  await metrics.record({ asked: 2, status: 'answered', ms: 500 })
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.entries.length, 1)
  assert.deepEqual(metrics.stats(), { count: 1 })
})

test('damaged rows are dropped and usable rows salvaged', async () => {
  const file = await tempFile()
  await writeFile(file, JSON.stringify({
    version: 99,
    entries: [
      null,
      'not an object',
      {},
      { status: 'not-a-status', asked: 9 },
      { status: 'answered', asked: 2, dropped: 1, ms: 500 },
    ],
  }), 'utf8')

  const metrics = await metricsAt(file)
  assert.deepEqual(metrics.stats(), { count: 1 })
  const summary = metrics.summary()
  assert.equal(summary.interviews, 1)
  assert.equal(summary.questions, 2)
  assert.equal(summary.answered, 1)
})

test('a bare array document is readable too', async () => {
  const file = await tempFile()
  await writeFile(file, JSON.stringify([{ status: 'skipped', asked: 2 }]), 'utf8')
  const metrics = await metricsAt(file)
  assert.equal(metrics.stats().count, 1)
  assert.equal(metrics.summary().skipped, 1)
})

test('statuses are normalized, and unknown ones are refused instead of invented', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)

  const camel = await metrics.record({ asked: 1, status: 'noClient' })
  assert.equal(camel.status, 'no_client')
  const dashed = await metrics.record({ asked: 1, status: 'No-Client' })
  assert.equal(dashed.status, 'no_client')

  assert.equal(await metrics.record({ asked: 1, status: 'busy' }), null)
  assert.equal(await metrics.record({ asked: 1 }), null)
  assert.equal(await metrics.record(null), null)

  assert.deepEqual(metrics.stats(), { count: 2 })
  assert.equal(metrics.summary().noClient, 2)
})

test('recorded fields are cleaned, not trusted', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)

  const entry = await metrics.record({
    sessionId: '  s1  ',
    asked: -2,
    dropped: 2.9,
    status: 'answered',
    ms: -5,
    at: 'not a time',
  })
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.kind, 'questions')
  assert.equal(entry.asked, 0)
  assert.equal(entry.dropped, 2)
  assert.equal(entry.ms, 0)
  assert.ok(Number.isFinite(entry.at) && entry.at > 0)

  const stamped = await metrics.record({ status: 'skipped', kind: ' review ', at: 1_700_000_000_000 })
  assert.equal(stamped.kind, 'review')
  assert.equal(stamped.at, 1_700_000_000_000)
})

test('recording without load still preserves the file on disk', async () => {
  const file = await tempFile()
  const seeded = await metricsAt(file)
  await seeded.record({ asked: 2, status: 'answered', ms: 100 })

  // A caller that never loaded must not replace the existing file.
  const lazy = createMetrics({ file })
  await lazy.record({ asked: 1, status: 'skipped' })
  assert.equal(lazy.summary().interviews, 2)
  assert.equal(lazy.summary().questions, 3)

  const reloaded = await metricsAt(file)
  assert.equal(reloaded.summary().interviews, 2)
  assert.equal(reloaded.summary().questions, 3)
})

test('concurrent records all land, serialized into one file', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file, { maxEntries: 10 })

  const written = await Promise.all(
    Array.from({ length: 20 }, (_, index) => metrics.record({
      asked: index,
      status: 'answered',
      ms: 100,
      sessionId: `s${index}`,
    })),
  )

  assert.equal(written.filter(Boolean).length, 20)
  assert.deepEqual(metrics.stats(), { count: 10 })
  const summary = metrics.summary()
  assert.equal(summary.interviews, 10)
  assert.equal(summary.questions, 145) // 10 + 11 + … + 19
  assert.equal(summary.avgQuestions, 14.5)
  assert.equal(summary.answerRate, 1)
  assert.equal(summary.avgAnswerMs, 100)

  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.entries.length, 10)
  assert.equal(document.entries[0].asked, 10)
  assert.equal(document.entries[document.entries.length - 1].asked, 19)
})

test('clear empties the store in memory and on disk', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)
  await metrics.record({ asked: 2, status: 'answered', ms: 500 })
  await metrics.record({ asked: 1, status: 'skipped' })

  await metrics.clear()
  assert.deepEqual(metrics.summary(), EMPTY_SUMMARY)
  assert.deepEqual(metrics.stats(), { count: 0 })

  const reloaded = await metricsAt(file)
  assert.deepEqual(reloaded.summary(), EMPTY_SUMMARY)
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.entries, [])
})

test('the report names every figure and formats rates as percentages', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)
  await metrics.record({ asked: 2, dropped: 1, status: 'answered', ms: 1_000 })
  await metrics.record({ asked: 1, status: 'answered', ms: 3_000 })
  await metrics.record({ asked: 3, dropped: 1, status: 'skipped' })
  await metrics.record({ asked: 2, status: 'timeout' })
  await metrics.record({ asked: 1, status: 'no_client' })
  await metrics.record({ asked: 1, status: 'dismissed' })
  await metrics.record({ asked: 1, status: 'off' })

  const text = renderReport(metrics.summary())
  for (const line of [
    'dsh-clarify 访谈指标',
    '  访谈记录：7 次',
    '  问题：11 个（平均 1.6 个/次）',
    '  丢弃：2 个（丢弃率 15.4%）',
    '  作答：2 次（作答率 28.6%）',
    '  跳过：1 次（跳过率 14.3%）',
    '  关闭面板：1 次',
    '  超时：1 次',
    '  没有提问界面：1 次',
    '  未开启澄清：1 次',
    '  平均作答耗时：2.0 秒',
  ]) {
    assert.ok(text.includes(line), `missing line: ${line}`)
  }
})

test('an empty report says so, and a report without answers has no answer time', async () => {
  assert.equal(renderReport(EMPTY_SUMMARY), '还没有访谈记录')
  assert.equal(renderReport(undefined), '还没有访谈记录')

  const noAnswers = renderReport({
    interviews: 2,
    questions: 0,
    dropped: 0,
    answered: 0,
    dismissed: 0,
    skipped: 2,
    timeout: 0,
    noClient: 0,
  })
  assert.ok(noAnswers.includes('平均作答耗时：—'))
  assert.ok(noAnswers.includes('跳过率 100.0%'))
})

test('the report recomputes rates the summary did not carry', () => {
  const text = renderReport({
    interviews: 2,
    questions: 3,
    dropped: 0,
    answered: 1,
  })
  assert.ok(text.includes('问题：3 个（平均 1.5 个/次）'))
  assert.ok(text.includes('作答：1 次（作答率 50.0%）'))
})

test('argv parsing accepts both --file spellings and reports bad input', () => {
  assert.deepEqual(parseArgs(['--file', '/tmp/m.json', '--json']), {
    file: '/tmp/m.json',
    json: true,
    help: false,
    error: '',
  })
  assert.equal(parseArgs(['--file=/tmp/m.json']).file, '/tmp/m.json')
  assert.equal(parseArgs(['-h']).help, true)
  assert.notEqual(parseArgs(['--file']).error, '')
  assert.notEqual(parseArgs(['--file=']).error, '')
  assert.notEqual(parseArgs(['--nope']).error, '')
})

test('main prints the report, the raw JSON, or a usage error', async () => {
  const file = await tempFile()
  const metrics = await metricsAt(file)
  await metrics.record({ asked: 2, dropped: 1, status: 'answered', ms: 1_500 })

  const out = []
  const errors = []
  const io = { write: text => out.push(text), writeError: text => errors.push(text) }

  assert.equal(await main(['--file', file], io), 0)
  assert.ok(out[0].includes('访谈记录：1 次'))
  assert.ok(out[0].includes('平均作答耗时：1.5 秒'))

  out.length = 0
  assert.equal(await main(['--file', file, '--json'], io), 0)
  assert.deepEqual(JSON.parse(out[0]), metrics.summary())

  assert.equal(await main(['--bogus'], io), 2)
  assert.ok(errors.some(line => line.includes('未知参数：--bogus')))

  assert.equal(await main(['--help'], io), 0)
  assert.ok(out.some(line => line.includes('用法：')))
})

test('the default path lives next to state.json, and an explicit file wins', () => {
  assert.equal(
    resolveMetricsPath({}, { DSH_HOME: '/tmp/dsh-home' }).replaceAll('\\', '/'),
    path.join('/tmp/dsh-home', 'clarify', 'metrics.json').replaceAll('\\', '/'),
  )
  assert.equal(
    resolveMetricsPath({ file: '/tmp/custom-metrics.json' }, {}).replaceAll('\\', '/'),
    path.resolve('/tmp/custom-metrics.json').replaceAll('\\', '/'),
  )
})

test('normalizeStatus is the one place the status spellings are decided', () => {
  assert.equal(normalizeStatus('answered'), 'answered')
  assert.equal(normalizeStatus(' NO_CLIENT '), 'no_client')
  assert.equal(normalizeStatus('noClient'), 'no_client')
  assert.equal(normalizeStatus('busy'), null)
  assert.equal(normalizeStatus(undefined), null)
  assert.equal(normalizeStatus(7), null)
})

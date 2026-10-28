#!/usr/bin/env node
/**
 * Print the interview metrics as a short Chinese report.
 *
 * The same data is worth reading two ways: a person wants the few numbers that
 * say whether asking works, and `--json` exists so the health integration (and
 * a test) can read the raw summary instead of scraping this text.
 *
 * Reading is the whole job here — recording lives on the tool path
 * (`lib/metrics.js`), not in a script someone has to remember to run.
 *
 * Usage: node tools/stats.mjs [--file <metrics.json>] [--json]
 *
 * @module dsh-clarify/tools/stats
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMetrics, resolveMetricsPath } from '../lib/metrics.js'

const USAGE = '用法：node tools/stats.mjs [--file <metrics.json>] [--json]'

/** @param {unknown} value */
const asNumber = value => (Number.isFinite(value) ? Number(value) : 0)

/**
 * A rate as one decimal of a percent. Clamped because a summary handed in from
 * elsewhere should still render, not produce `150.0%`.
 *
 * @param {number} rate
 * @returns {string}
 */
function percent(rate) {
  return `${(Math.max(0, Math.min(1, rate)) * 100).toFixed(1)}%`
}

/**
 * Render a {@link import('../lib/metrics.js').MetricSummary} as plain text.
 *
 * Missing derived fields are recomputed from the counts, so a caller that only
 * has the raw counts still gets the same report.
 *
 * @param {object} [summary]
 * @returns {string} one line per figure; a single line when there is no data
 */
export function renderReport(summary) {
  const source = summary !== null && typeof summary === 'object' ? summary : {}
  const interviews = Math.max(0, Math.trunc(asNumber(source.interviews)))
  if (interviews === 0) return '还没有访谈记录'

  const questions = Math.max(0, Math.trunc(asNumber(source.questions)))
  const dropped = Math.max(0, Math.trunc(asNumber(source.dropped)))
  const answered = Math.max(0, Math.trunc(asNumber(source.answered)))
  const dismissed = Math.max(0, Math.trunc(asNumber(source.dismissed)))
  const skipped = Math.max(0, Math.trunc(asNumber(source.skipped)))
  const timeout = Math.max(0, Math.trunc(asNumber(source.timeout)))
  const noClient = Math.max(0, Math.trunc(asNumber(source.noClient)))

  const avgQuestions = Number.isFinite(source.avgQuestions)
    ? Number(source.avgQuestions)
    : questions / interviews
  const dropRate = Number.isFinite(source.dropRate)
    ? Number(source.dropRate)
    : questions + dropped === 0 ? 0 : dropped / (questions + dropped)
  const answerRate = Number.isFinite(source.answerRate)
    ? Number(source.answerRate)
    : answered / interviews
  const skipRate = Number.isFinite(source.skipRate)
    ? Number(source.skipRate)
    : skipped / interviews
  const avgAnswerMs = asNumber(source.avgAnswerMs)

  const lines = [
    'dsh-clarify 访谈指标',
    `  访谈记录：${interviews} 次`,
    `  问题：${questions} 个（平均 ${avgQuestions.toFixed(1)} 个/次）`,
    `  丢弃：${dropped} 个（丢弃率 ${percent(dropRate)}）`,
    `  作答：${answered} 次（作答率 ${percent(answerRate)}）`,
    `  跳过：${skipped} 次（跳过率 ${percent(skipRate)}）`,
    `  关闭面板：${dismissed} 次`,
    `  超时：${timeout} 次`,
    `  没有提问界面：${noClient} 次`,
  ]
  // `off` has no field of its own in the summary; it is the remainder, which is
  // exactly why records with status `off` still count as interviews.
  const off = interviews - (answered + dismissed + skipped + timeout + noClient)
  if (off > 0) lines.push(`  未开启澄清：${off} 次`)
  lines.push(`  平均作答耗时：${answered === 0 ? '—' : `${(avgAnswerMs / 1000).toFixed(1)} 秒`}`)
  return lines.join('\n')
}

/**
 * Split argv into flags. Errors are returned rather than thrown so `main` can
 * decide the exit code (and a test can assert on it).
 *
 * @param {string[]} [argv]
 * @returns {{ file: string, json: boolean, help: boolean, error: string }}
 */
export function parseArgs(argv = []) {
  const options = { file: '', json: false, help: false, error: '' }
  const fail = message => {
    if (options.error === '') options.error = message
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--file') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        fail('--file 后面要跟一个文件路径')
      } else {
        options.file = value
        index += 1
      }
    } else if (argument.startsWith('--file=')) {
      const value = argument.slice('--file='.length)
      if (value === '') fail('--file= 后面要跟一个文件路径')
      else options.file = value
    } else {
      fail(`未知参数：${argument}`)
    }
  }
  return options
}

/**
 * Run the CLI. `io` is injectable so a test can read what would be printed
 * without touching the real stdout.
 *
 * @param {string[]} [argv]
 * @param {{ write?: (text: string) => void, writeError?: (text: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const write = typeof io.write === 'function' ? io.write : text => process.stdout.write(`${text}\n`)
  const writeError = typeof io.writeError === 'function'
    ? io.writeError
    : text => process.stderr.write(`${text}\n`)

  const options = parseArgs(argv)
  if (options.error !== '') {
    writeError(options.error)
    writeError(USAGE)
    return 2
  }
  if (options.help) {
    write(USAGE)
    return 0
  }

  const file = options.file !== '' ? options.file : resolveMetricsPath()
  const metrics = createMetrics({ file })
  try {
    await metrics.load()
  } catch (error) {
    // `load` is documented never to throw, but the CLI still owes a message.
    writeError(`读取失败：${error?.message ?? error}`)
    return 1
  }

  const summary = metrics.summary()
  write(options.json ? JSON.stringify(summary, null, 2) : renderReport(summary))
  return 0
}

/**
 * Whether this file is the entry point rather than an import.
 * Windows paths compare case-insensitively; POSIX paths do not.
 *
 * @returns {boolean}
 */
function invokedDirectly() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    const left = path.resolve(entry)
    const right = fileURLToPath(import.meta.url)
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exitCode = await main()

/**
 * Interview metrics, on disk.
 *
 * The research note behind clarify mode says the quiet part out loud: rework —
 * the thing everyone wants less of — is not measured anywhere. This module does
 * not fix that. It only makes the measurable half honest: how many questions we
 * asked, how many we threw away before asking, how often the person answered,
 * skipped, had the panel closed, timed out or never saw one, and how long an
 * answer took.
 *
 * Shape and rules follow `./state.js` on purpose:
 *
 *  - **One record per interview attempt.** `interviews` counts records, not
 *    sessions: one session can be interviewed twice, and an attempt that ended
 *    with `status: 'off'` is still an attempt — it just produced no question.
 *  - **Writes are serialized and atomic.** Recording runs on the tool path
 *    while a prompt is in flight; one promise chain plus temp file + rename
 *    means a reader never sees half an entry list.
 *  - **A damaged file is "no data", not an exception.** The report has to work
 *    on a machine where a crash truncated the file; the bad file is left in
 *    place so nothing is destroyed before someone can look at it.
 *
 * Rates are fractions in `0…1`, not percentages — {@link renderReport} in
 * `tools/stats.mjs` is what turns them into text.
 *
 * @module dsh-clarify/metrics
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveHomeDir } from './state.js'

/** Document version. Unknown versions are still read field-by-field. */
export const SCHEMA_VERSION = 1

/** Records kept on disk; the oldest are dropped first. */
export const MAX_ENTRIES = 500

/**
 * Every outcome the panel can hand back. `off` means clarify mode was disabled,
 * so the questions were never shown.
 *
 * @type {readonly string[]}
 */
export const STATUSES = Object.freeze(['answered', 'dismissed', 'skipped', 'timeout', 'no_client', 'off'])

/** Correlation counter for temp files; the write chain already serializes them. */
let tempCounter = 0

/**
 * Round to a fixed number of decimals so summaries stay comparable in tests and
 * in JSON rather than carrying float noise.
 *
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * @param {unknown} value
 * @returns {number} a non-negative whole count, `0` for anything unusable
 */
function toCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/**
 * @param {unknown} value
 * @returns {number} a non-negative whole millisecond value, `0` for anything unusable
 */
function toMillis(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/**
 * Map a reported status onto the canonical spelling.
 *
 * Accepts `noClient` and `no-client` as well, because the summary field is
 * camelCase and an integrator will eventually copy that spelling into a record.
 * An unknown value stays unknown: metrics must not invent an outcome.
 *
 * @param {unknown} value
 * @returns {string | null} the canonical status, or `null`
 */
export function normalizeStatus(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('-', '_') : ''
  if (raw === '') return null
  const status = raw === 'noclient' ? 'no_client' : raw
  return STATUSES.includes(status) ? status : null
}

/**
 * An explicit `file` wins; otherwise `$DSH_HOME/clarify/metrics.json`.
 *
 * @param {{ file?: string }} [config]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute path
 */
export function resolveMetricsPath(config = {}, env = process.env) {
  const configured = typeof config.file === 'string' ? config.file.trim() : ''
  if (configured !== '') return path.resolve(configured)
  return path.join(resolveHomeDir(env), 'clarify', 'metrics.json')
}

/**
 * @typedef {object} MetricEntry
 * @property {string} sessionId - Session the attempt belonged to; `''` when unknown.
 * @property {string} kind - `'questions'` (or `'review'`); free text, trimmed.
 * @property {number} asked - Questions actually shown to the person.
 * @property {number} dropped - Questions discarded before asking (impact filter, cap).
 * @property {'answered'|'dismissed'|'skipped'|'timeout'|'no_client'|'off'} status
 * @property {number} ms - Asked→settled elapsed time; `0` when unknown.
 * @property {number} at - Epoch ms of the outcome.
 */

/**
 * @typedef {object} MetricSummary
 * @property {number} interviews - Records. Every attempt counts, `off` included.
 * @property {number} questions - Sum of `asked`.
 * @property {number} avgQuestions - `questions / interviews`, 2 decimals.
 * @property {number} dropped - Sum of `dropped`.
 * @property {number} dropRate - `dropped / (questions + dropped)`, 4 decimals.
 * @property {number} answered
 * @property {number} dismissed
 * @property {number} skipped
 * @property {number} timeout
 * @property {number} noClient
 * @property {number} answerRate - `answered / interviews`, 4 decimals.
 * @property {number} skipRate - `skipped / interviews`, 4 decimals.
 * @property {number} avgAnswerMs - Mean over `answered` records with a positive `ms`.
 */

/**
 * Salvage one stored row. A row without a known status was not written by this
 * module (or was hand-edited) and is dropped — an unclassifiable attempt is not
 * a metric.
 *
 * @param {unknown} raw
 * @returns {MetricEntry | null}
 */
export function normalizeEntry(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : null
  if (source === null) return null
  const status = normalizeStatus(source.status)
  if (status === null) return null
  return {
    sessionId: typeof source.sessionId === 'string' ? source.sessionId.trim() : '',
    kind: typeof source.kind === 'string' && source.kind.trim() !== '' ? source.kind.trim() : 'questions',
    asked: toCount(source.asked),
    dropped: toCount(source.dropped),
    status,
    ms: toMillis(source.ms),
    at: Number.isFinite(source.at) ? Math.trunc(Number(source.at)) : 0,
  }
}

/**
 * @typedef {object} MetricsStore
 * @property {() => Promise<void>} load
 * @property {(input?: object) => Promise<MetricEntry | null>} record
 * @property {() => MetricSummary} summary
 * @property {() => Promise<void>} clear
 * @property {() => { count: number }} stats
 * @property {string} file
 */

/**
 * @param {{ file?: string, logger?: object, now?: () => number, maxEntries?: number }} [options]
 * @returns {MetricsStore}
 */
export function createMetrics({ file, logger, now = () => Date.now(), maxEntries = MAX_ENTRIES } = {}) {
  const target = typeof file === 'string' && file.trim() !== '' ? file : resolveMetricsPath()
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_ENTRIES

  /**
   * Oldest first, so appending is cheap and eviction is a slice from the front.
   * @type {MetricEntry[]}
   */
  let entries = []
  /** Every mutation waits for the previous one; failures never poison the chain. */
  let chain = Promise.resolve()
  let loadPromise = null

  const warn = (message, detail) => {
    try {
      logger?.warn?.(`dsh-clarify: ${message}`, detail ?? '')
    } catch {
      /* logging must never be the failure */
    }
  }

  async function persist() {
    const text = `${JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2)}\n`
    const directory = path.dirname(target)
    await mkdir(directory, { recursive: true })
    tempCounter += 1
    const temp = `${target}.${process.pid}.${tempCounter.toString(36)}.tmp`
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, target)
    } catch (error) {
      // Do not leave debris behind when the rename is the thing that failed.
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Apply one mutation after every earlier one, then persist.
   *
   * `load()` runs first, memoized, so a caller that forgot to load cannot
   * replace a full metrics file with the one record it is adding.
   *
   * @template T
   * @param {() => T} mutate
   * @returns {Promise<T>}
   */
  function write(mutate) {
    const next = chain.then(async () => {
      await load()
      const result = mutate()
      try {
        await persist()
      } catch (error) {
        warn(`could not save ${target}`, error)
      }
      return result
    })
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Read the record list once. The result is memoized: a second call is free and
   * — more importantly — can never discard records collected in this process
   * after the first read. A missing, unreadable, or invalid file leaves the
   * store empty instead of throwing.
   *
   * @returns {Promise<void>}
   */
  async function load() {
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      let text
      try {
        text = await readFile(target, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`could not read ${target}`, error)
        return
      }
      let document
      try {
        document = JSON.parse(text)
      } catch (error) {
        warn(`${target} is not valid JSON; starting with no data (the file is kept)`, error)
        return
      }
      // Accept a bare array too: an older or hand-written file is still readable.
      const rows = Array.isArray(document)
        ? document
        : document !== null && typeof document === 'object' && Array.isArray(document.entries)
          ? document.entries
          : []
      const restored = []
      for (const raw of rows) {
        const entry = normalizeEntry(raw)
        if (entry !== null) restored.push(entry)
      }
      entries = restored.slice(-limit)
      if (restored.length > limit) {
        warn(`kept the newest ${limit} of ${restored.length} metric row(s) from ${target}`)
      }
    })()
    return loadPromise
  }

  /**
   * Add one attempt. A record without a known status is refused (with a
   * warning): silently inventing `off` for a typo would corrupt every rate.
   *
   * @param {{ sessionId?: string, kind?: string, asked?: number, dropped?: number, status?: string, ms?: number, at?: number }} [input]
   * @returns {Promise<MetricEntry | null>}
   */
  function record(input = {}) {
    const source = input !== null && typeof input === 'object' ? input : null
    if (source === null) return Promise.resolve(null)
    const status = normalizeStatus(source.status)
    if (status === null) {
      const shown = source.status === undefined ? 'missing' : `'${String(source.status)}'`
      warn(`ignoring a metric with an unknown status (${shown})`)
      return Promise.resolve(null)
    }
    const at = Number.isFinite(Number(source.at)) && Number(source.at) > 0
      ? Math.trunc(Number(source.at))
      : now()
    const entry = {
      sessionId: typeof source.sessionId === 'string' ? source.sessionId.trim() : '',
      kind: typeof source.kind === 'string' && source.kind.trim() !== '' ? source.kind.trim() : 'questions',
      asked: toCount(source.asked),
      dropped: toCount(source.dropped),
      status,
      ms: toMillis(source.ms),
      at,
    }
    return write(() => {
      entries.push(entry)
      if (entries.length > limit) entries = entries.slice(entries.length - limit)
      return { ...entry }
    })
  }

  function summary() {
    /** @type {Record<string, number>} */
    const byStatus = { answered: 0, dismissed: 0, skipped: 0, timeout: 0, no_client: 0, off: 0 }
    let questions = 0
    let dropped = 0
    let answerMs = 0
    let answeredWithTime = 0

    for (const entry of entries) {
      questions += entry.asked
      dropped += entry.dropped
      byStatus[entry.status] += 1
      // Only real answers have an answer time; timeouts would fake a long one.
      if (entry.status === 'answered' && entry.ms > 0) {
        answerMs += entry.ms
        answeredWithTime += 1
      }
    }

    const interviews = entries.length
    const rate = (part, whole) => (whole === 0 ? 0 : round(part / whole, 4))
    return {
      interviews,
      questions,
      avgQuestions: interviews === 0 ? 0 : round(questions / interviews, 2),
      dropped,
      // The denominator is every question the model proposed, so discarded ones
      // count in it — otherwise a perfect filter would look like it asked a lot.
      dropRate: rate(dropped, questions + dropped),
      answered: byStatus.answered,
      dismissed: byStatus.dismissed,
      skipped: byStatus.skipped,
      timeout: byStatus.timeout,
      noClient: byStatus.no_client,
      answerRate: rate(byStatus.answered, interviews),
      skipRate: rate(byStatus.skipped, interviews),
      avgAnswerMs: answeredWithTime === 0 ? 0 : Math.round(answerMs / answeredWithTime),
    }
  }

  function clear() {
    return write(() => {
      entries = []
    })
  }

  return {
    file: target,
    load,
    record,
    summary,
    clear,
    stats() {
      return { count: entries.length }
    },
  }
}

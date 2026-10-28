/**
 * Per-session clarify state, on disk.
 *
 * One JSON file under `$DSH_HOME/clarify/state.json` holds, for each session
 * that has ever touched the mode: whether it is on, the approved requirement
 * card, and when it was approved. A file (rather than a session-log event)
 * keeps the plugin free of any `@deepseek-ai/*` import and therefore of every
 * session-format and projection migration — the trade is that state is keyed
 * by session id instead of being projected from the log.
 *
 * Two rules the store owes its callers:
 *
 *  - **Reads are synchronous and never create rows.** The prompt section is a
 *    synchronous provider evaluated before every request; it must not allocate
 *    on behalf of a session that merely happens to render a prompt.
 *  - **Writes are serialized and atomic.** The browser pill and the agent tool
 *    write the same file, so every mutation runs through one promise chain and
 *    lands via a temp file + rename; a half-written state file can never make
 *    the plugin forget everyone's mode.
 *
 * @module dsh-clarify/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Document version. Unknown versions are salvaged field-by-field, not dropped. */
export const SCHEMA_VERSION = 1

/** Sessions kept on disk; the least recently touched ones are pruned. */
export const MAX_SESSIONS = 300

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} the DSH home directory
 */
export function resolveHomeDir(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured === '' ? path.join(homedir(), '.dsh') : configured
}

/**
 * An explicit `storePath` wins; otherwise `$DSH_HOME/clarify/state.json`.
 *
 * @param {{ storePath?: string }} [config]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute path
 */
export function resolveStatePath(config = {}, env = process.env) {
  const configured = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  if (configured !== '') return path.resolve(configured)
  return path.join(resolveHomeDir(env), 'clarify', 'state.json')
}

/**
 * @returns {{ enabled: boolean, brief: string, approvedAt: number | null, updatedAt: number }}
 */
export function emptyEntry() {
  return { enabled: false, brief: '', approvedAt: null, updatedAt: 0 }
}

/**
 * Salvage one stored row. Anything that is not exactly a usable row becomes the
 * empty row — losing one mode flag is cheaper than failing the whole file.
 *
 * @param {unknown} raw
 * @returns {{ enabled: boolean, brief: string, approvedAt: number | null, updatedAt: number }}
 */
export function normalizeEntry(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const brief = typeof source.brief === 'string' ? source.brief : ''
  const approvedAt = Number.isFinite(source.approvedAt) ? Number(source.approvedAt) : null
  return {
    enabled: source.enabled === true,
    brief,
    // A card without an approval stamp is not approved; keep the text, drop the claim.
    approvedAt: brief.trim() === '' ? null : approvedAt,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : 0,
  }
}

/**
 * @typedef {object} StateStore
 * @property {() => Promise<void>} load
 * @property {(sessionId: string) => { enabled: boolean, brief: string, approvedAt: number | null, updatedAt: number }} get
 * @property {(sessionId: string) => { enabled: boolean, approved: boolean, brief: string, approvedAt: number | null }} view
 * @property {(sessionId: string, enabled: boolean) => Promise<object>} setEnabled
 * @property {(sessionId: string, brief: string) => Promise<object>} approve
 * @property {(sessionId: string) => Promise<object>} clearBrief
 * @property {() => { sessions: number, enabled: number }} stats
 * @property {() => Promise<void>} flush
 * @property {string} file
 */

/**
 * @param {{ file?: string, logger?: object, now?: () => number, maxSessions?: number, defaultEnabled?: boolean }} [options]
 * @returns {StateStore}
 */
export function createStateStore(options = {}) {
  const file = options.file ?? resolveStatePath()
  const logger = options.logger
  const now = options.now ?? (() => Date.now())
  const defaultEnabled = options.defaultEnabled === true
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : MAX_SESSIONS

  /** @type {Map<string, ReturnType<typeof emptyEntry>>} */
  const sessions = new Map()
  let chain = Promise.resolve()
  let loadPromise = null

  const warn = (message, detail) => {
    try {
      logger?.warn?.(`dsh-clarify: ${message}`, detail ?? '')
    } catch {
      /* logging must never be the failure */
    }
  }

  /** @param {unknown} sessionId */
  function keyOf(sessionId) {
    return typeof sessionId === 'string' ? sessionId.trim() : ''
  }

  function get(sessionId) {
    const id = keyOf(sessionId)
    if (id === '') return { ...emptyEntry(), enabled: defaultEnabled }
    const stored = sessions.get(id)
    // A session with no row follows the deployment default; clicking the pill
    // writes the row, so an explicit choice always beats the default.
    return stored === undefined ? { ...emptyEntry(), enabled: defaultEnabled } : { ...stored }
  }

  function view(sessionId) {
    const entry = get(sessionId)
    return {
      enabled: entry.enabled,
      approved: entry.brief !== '' && entry.approvedAt !== null,
      brief: entry.brief,
      approvedAt: entry.approvedAt,
    }
  }

  function prune() {
    if (sessions.size <= maxSessions) return
    const rows = [...sessions.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [id] of rows.slice(0, sessions.size - maxSessions)) sessions.delete(id)
  }

  async function persist() {
    /** @type {Record<string, object>} */
    const rows = {}
    for (const [id, entry] of sessions) rows[id] = entry
    const text = `${JSON.stringify({ version: SCHEMA_VERSION, sessions: rows }, null, 2)}\n`
    const directory = path.dirname(file)
    await mkdir(directory, { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  }

  /**
   * Apply one mutation after every earlier one, then persist.
   * The in-memory row moves *before* the write so the very next prompt
   * assembly already reflects what the person clicked.
   *
   * @template T
   * @param {() => T} mutate
   * @returns {Promise<T>}
   */
  function write(mutate) {
    const next = chain.then(async () => {
      const result = mutate()
      prune()
      try {
        await persist()
      } catch (error) {
        warn(`could not save ${file}`, error)
      }
      return result
    })
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  async function load() {
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`could not read ${file}`, error)
        return
      }
      let document
      try {
        document = JSON.parse(text)
      } catch (error) {
        warn(`${file} is not valid JSON; starting empty (the file is kept)`, error)
        return
      }
      const rows = document !== null && typeof document === 'object' && document.sessions !== null
        && typeof document.sessions === 'object'
        ? document.sessions
        : {}
      for (const [id, raw] of Object.entries(rows)) {
        if (typeof id !== 'string' || id.trim() === '') continue
        sessions.set(id, normalizeEntry(raw))
      }
      warn(`loaded ${sessions.size} session row(s) from ${file}`)
    })()
    return loadPromise
  }

  return {
    file,
    load,
    get,
    view,
    setEnabled(sessionId, enabled) {
      const id = keyOf(sessionId)
      if (id === '') return Promise.resolve(emptyEntry())
      return write(() => {
        const entry = { ...get(id), enabled: enabled === true, updatedAt: now() }
        sessions.set(id, entry)
        return { ...entry }
      })
    },
    approve(sessionId, brief) {
      const id = keyOf(sessionId)
      if (id === '') return Promise.resolve(emptyEntry())
      return write(() => {
        const entry = { ...get(id), brief, approvedAt: now(), updatedAt: now() }
        sessions.set(id, entry)
        return { ...entry }
      })
    },
    clearBrief(sessionId) {
      const id = keyOf(sessionId)
      if (id === '') return Promise.resolve(emptyEntry())
      return write(() => {
        const entry = { ...get(id), brief: '', approvedAt: null, updatedAt: now() }
        sessions.set(id, entry)
        return { ...entry }
      })
    },
    stats() {
      let enabled = 0
      for (const entry of sessions.values()) if (entry.enabled) enabled += 1
      return { sessions: sessions.size, enabled }
    },
    async flush() {
      await chain
    },
  }
}

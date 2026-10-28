/**
 * The interview queue: the host-side half of the plugin's own question panel.
 *
 * A tool call cannot render UI, so the flow is inverted: the tool registers a
 * *pending interview* for its session, the browser panel picks it up, and the
 * person's answer comes back through an HTTP route that settles the pending
 * entry and unblocks the tool.
 *
 * Three properties this queue owes the plugin:
 *
 *  - **One pending interview per session.** The model is a single blocked
 *    caller; a second pending would be a second question nobody can tell apart
 *    from the first. A second `ask` while one is open is refused, not queued.
 *  - **The question lives here, not in the browser.** A reload, a second tab,
 *    or a panel that mounts late still finds the same questions and the same
 *    ids — that is what makes "刷新不丢问题" true rather than hopeful.
 *  - **Every wait ends.** Answered, cancelled, skipped, aborted, timed out,
 *    plugin unloaded: each has a status, so no tool call can hang forever.
 *
 * Client presence is tracked here too: the panel polls, and each poll refreshes
 * a timestamp. `clientAlive()` is how the tools decide between the panel and
 * the built-in one-question-at-a-time fallback.
 *
 * @module dsh-clarify/interview
 */

/** How recently the panel must have polled for its presence to count. */
export const CLIENT_GRACE_MS = 15_000

/** No answer for this long and the wait ends with `timeout`. */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

let counter = 0

/** Short, collision-free pending id. Not a security boundary — a correlation key. */
function nextId() {
  counter += 1
  return `ask-${Date.now().toString(36)}-${counter.toString(36)}`
}

/**
 * @typedef {object} InterviewRequest
 * @property {'questions' | 'review'} kind
 * @property {object} payload - Sent to the panel verbatim.
 *
 * @typedef {object} InterviewResult
 * @property {'answered' | 'dismissed' | 'skipped' | 'timeout' | 'busy' | 'unloaded'} status
 * @property {Array<{ id: string, selected: string[], custom: string }>} [answers]
 * @property {string} [note]
 */

/**
 * @param {{ logger?: object, now?: () => number, timeoutMs?: number, graceMs?: number }} [options]
 */
export function createInterview(options = {}) {
  const logger = options.logger
  const now = options.now ?? (() => Date.now())
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const graceMs = Number.isSafeInteger(options.graceMs) && options.graceMs > 0
    ? options.graceMs
    : CLIENT_GRACE_MS

  /** @type {Map<string, { id: string, kind: string, payload: object, createdAt: number, resolve: Function, timer: any }>} */
  const pendings = new Map()
  /** @type {Map<string, number>} */
  const seen = new Map()

  const keyOf = sessionId => (typeof sessionId === 'string' ? sessionId.trim() : '')

  /** Mark a session's panel as present right now (called by every panel poll). */
  function touch(sessionId) {
    const id = keyOf(sessionId)
    if (id !== '') seen.set(id, now())
  }

  /** Whether a panel has polled for this session recently enough to trust. */
  function clientAlive(sessionId) {
    const id = keyOf(sessionId)
    if (id === '') return false
    const at = seen.get(id)
    return at !== undefined && now() - at < graceMs
  }

  /** @param {string} sessionId @param {InterviewResult} result */
  function settle(sessionId, result) {
    const entry = pendings.get(sessionId)
    if (entry === undefined) return false
    clearTimeout(entry.timer)
    pendings.delete(sessionId)
    entry.resolve(result)
    return true
  }

  /**
   * Register one pending interview and wait for it.
   *
   * @param {string} sessionId
   * @param {{ kind: 'questions' | 'review', payload: object }} request
   * @returns {Promise<InterviewResult>}
   */
  function ask(sessionId, request) {
    const id = keyOf(sessionId)
    if (id === '') return Promise.resolve({ status: 'unloaded', note: '没有会话 id' })
    if (pendings.has(id)) return Promise.resolve({ status: 'busy', note: '这个会话已经有一组待回答的问题' })
    return new Promise((resolve) => {
      /** @type {any} */
      let timer = null
      const entry = { id: nextId(), kind: request.kind, payload: request.payload, createdAt: now(), resolve, timer }
      timer = setTimeout(() => {
        settle(id, { status: 'timeout', note: '用户一直没有回答' })
      }, timeoutMs)
      timer?.unref?.()
      entry.timer = timer
      pendings.set(id, entry)
      logger?.debug?.(`dsh-clarify: pending ${entry.id} (${request.kind}) for ${id}`)
    })
  }

  /**
   * @param {string} sessionId
   * @param {string} pendingId
   * @param {Array<{ id: string, selected: string[], custom: string }>} answers
   * @returns {boolean} whether an unchanged pending entry settled
   */
  function answer(sessionId, pendingId, answers) {
    const id = keyOf(sessionId)
    const entry = pendings.get(id)
    if (entry === undefined || entry.id !== pendingId) return false
    touch(id)
    return settle(id, { status: 'answered', answers })
  }

  /**
   * @param {string} sessionId
   * @param {string} pendingId
   * @param {'dismissed' | 'skipped'} reason
   * @returns {boolean}
   */
  function cancel(sessionId, pendingId, reason = 'dismissed') {
    const id = keyOf(sessionId)
    const entry = pendings.get(id)
    if (entry === undefined) return false
    if (pendingId !== undefined && pendingId !== '' && entry.id !== pendingId) return false
    return settle(id, { status: reason === 'skipped' ? 'skipped' : 'dismissed' })
  }

  /** The pending interview for a panel to render, or `null`. */
  function pendingView(sessionId) {
    const entry = pendings.get(keyOf(sessionId))
    if (entry === undefined) return null
    return { id: entry.id, kind: entry.kind, createdAt: entry.createdAt, ...entry.payload }
  }

  /**
   * Every session currently waiting for an answer.
   *
   * The panel only renders for the session in front of you, so this is how the
   * sidebar can say "another session is waiting" instead of leaving a blocked
   * model invisible until the timeout.
   *
   * @returns {Array<{ session: string, id: string, kind: string, count: number, createdAt: number }>}
   */
  function list() {
    return [...pendings.entries()]
      .map(([session, entry]) => ({
        session,
        id: entry.id,
        kind: entry.kind,
        count: Array.isArray(entry.payload?.questions) ? entry.payload.questions.length : 1,
        createdAt: entry.createdAt,
      }))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** End every wait — used when the plugin unloads so no tool stays suspended. */
  function closeAll(status = 'unloaded') {
    for (const [id] of [...pendings]) settle(id, { status, note: '插件已卸载' })
  }

  function stats() {
    return { pending: pendings.size, clients: seen.size }
  }

  return { touch, clientAlive, ask, answer, cancel, pendingView, list, closeAll, stats, timeoutMs, graceMs }
}

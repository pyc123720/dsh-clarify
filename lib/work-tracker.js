/**
 * Whether a session has already started changing the project.
 *
 * The intake script says `goal` questions (what are we even making?) belong to
 * the time *before* work starts. Once the agent has run `write` or `edit`, a
 * goal question is stale by construction — it should be dropped rather than
 * asked, and the model should be told why.
 *
 * The only honest source for that fact is the session event stream: a write
 * tool either ran or it did not. This tracker subscribes to nothing itself; it
 * exposes {@link observe}, which `lib/index.js` wires to `session/event`, and a
 * pure lookup which the tools use. State is a `Set` in memory — whether work
 * started is a fact about *this* process's session history, and persisting it
 * would only keep a stale answer alive after a restart.
 *
 * @module dsh-clarify/work-tracker
 */

/**
 * Tool names that mean the agent is no longer in intake.
 *
 * Deliberately reads-and-writes only: a `bash` call might be a build or might
 * be `ls`, so it does not count. A new writing tool would have to be added here
 * before its sessions can suppress stale goal questions.
 */
export const WRITE_TOOLS = Object.freeze([
  'write',
  'edit',
  'apply_patch',
  'multi_edit',
  'str_replace',
  'create_file',
])

/**
 * @param {unknown} session - The event's session object, or its id.
 * @returns {string} trimmed id, `''` when unusable
 */
function sessionKey(session) {
  const id = typeof session === 'string' ? session : session?.id
  return typeof id === 'string' ? id.trim() : ''
}

/**
 * @param {{ logger?: object }} [options]
 * @returns {{
 *   observe: (session: unknown, event: unknown) => boolean,
 *   hasStartedWork: (sessionId: unknown) => boolean,
 *   reset: () => void,
 *   size: () => number,
 * }}
 */
export function createWorkTracker({ logger } = {}) {
  /** @type {Set<string>} */
  const started = new Set()

  /**
   * Note one session event. Returns whether this event marked a session started.
   *
   * Malformed events are ignored: an observer on a hot path must never be the
   * reason a turn fails.
   *
   * @param {unknown} session
   * @param {unknown} event
   * @returns {boolean}
   */
  function observe(session, event) {
    try {
      if (event === null || typeof event !== 'object') return false
      if (event.type !== 'tool/call') return false
      const data = event.data !== null && typeof event.data === 'object' ? event.data : null
      const name = typeof data?.name === 'string' ? data.name.trim() : ''
      if (name === '' || !WRITE_TOOLS.includes(name)) return false
      const id = sessionKey(session)
      if (id === '') return false
      started.add(id)
      return true
    } catch (error) {
      try {
        logger?.warn?.(`dsh-clarify: could not observe a session event: ${error?.message ?? error}`)
      } catch {
        /* logging must never be the failure */
      }
      return false
    }
  }

  /**
   * @param {unknown} sessionId
   * @returns {boolean}
   */
  function hasStartedWork(sessionId) {
    const id = sessionKey(sessionId)
    return id !== '' && started.has(id)
  }

  return {
    observe,
    hasStartedWork,
    reset() {
      started.clear()
    },
    size() {
      return started.size
    },
  }
}

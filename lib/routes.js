/**
 * The panel's HTTP surface.
 *
 * Seven exact routes under `/api/clarify`: state, pending, answer, cancel,
 * toggle, clear, health. The pill and the interview panel both speak this small
 * vocabulary, and the interview routes are the only way a waiting tool call can
 * be unblocked — which is why they validate their payload instead of trusting it.
 *
 * Every route is fenced twice, like the global-todo plugin: the Host's own
 * connection fence (`connection.requestRejection`, which authenticates a browser
 * against this process's token and trusted hosts) when that service exists, and
 * a strict loopback rule as the fallback for leaner compositions. A local
 * credential-less caller (a script on this machine) is carved out by the
 * loopback rule, which is what keeps `curl` diagnostics working. Anything that
 * reaches a LAN client with no cookie is refused before the handler runs.
 *
 * `GET /pending` doubles as the panel's heartbeat: every poll touches the
 * session's presence, which is what tells the tools a panel exists at all.
 *
 * @module dsh-clarify/routes
 */

/** Route prefix. The client appends this to the document base. */
export const ROUTE_BASE = '/api/clarify'

/** A toggle body is tiny; anything larger is not a toggle. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(response, status, body) {
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: 'response is not serializable' })
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown> | null>} parsed object body, or null
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('body too large')
      error.code = 'TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Only a same-origin page may change state. Browsers attach `Origin` to a
 * cross-site POST, so an absent header means a local non-browser caller.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function writeAllowed(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {URLSearchParams}
 */
function query(request) {
  return new URL(request.url ?? '/', 'http://localhost').searchParams
}

/**
 * Is this request from this machine?
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * A browser request carries a cookie or an `Origin`; a local script carries
 * neither.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function hasBrowserCredentials(request) {
  const cookie = request?.headers?.cookie
  if (typeof cookie === 'string' && cookie.trim() !== '') return true
  const origin = request?.headers?.origin
  return typeof origin === 'string' && origin.trim() !== ''
}

/**
 * Validate one answers payload without trusting any of it.
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, selected: string[], custom: string }> | null}
 */
export function normalizeAnswers(raw) {
  if (!Array.isArray(raw)) return null
  const answers = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') return null
    const selected = Array.isArray(entry.selected)
      ? entry.selected.filter(item => typeof item === 'string')
      : []
    const custom = typeof entry.custom === 'string' ? entry.custom : ''
    answers.push({ id, selected, custom })
  }
  return answers
}

/**
 * @param {object} deps
 * @param {import('./state.js').StateStore} deps.store
 * @param {object} deps.interview
 * @param {import('./preferences.js').PreferenceStore} [deps.preferences] - Approved-card archive, for `/health`.
 * @param {import('./metrics.js').MetricsStore} [deps.metrics] - Interview metrics, for `/health`.
 * @param {string} deps.version
 * @param {object} [deps.logger]
 * @param {object} [deps.surfaces] - Live registration flags, reported by `/health`.
 * @param {() => object | undefined} [deps.connection] - Connection fence, read per request.
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function createRoutes({ store, interview, preferences, metrics, version, logger, surfaces, connection }) {
  /**
   * The Host's connection fence, evaluated per request.
   *
   * Returning `false` means "already answered with an error". A fence that
   * throws fails closed (403) rather than falling through to the loopback
   * carve-out.
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {boolean}
   */
  function allowed(request, response) {
    let rejection
    let fenceError = false
    let service
    try {
      service = connection?.()
      rejection = service?.requestRejection?.(request)
    } catch (error) {
      logger?.warn?.(`dsh-clarify: connection fence failed: ${error?.message ?? error}`)
      rejection = 403
      fenceError = true
    }
    const fenced = typeof rejection === 'number'
    // A local script (no cookie, no Origin, from this machine) is not a browser
    // and cannot be a cross-site actor; it is judged by the loopback rule.
    const localScript = fenceError !== true && isLoopbackRequest(request) && !hasBrowserCredentials(request)
    if (fenced && !localScript) {
      sendJson(response, rejection, { ok: false, error: 'request refused by the host connection fence' })
      return false
    }
    if (!fenced && (service === undefined || service === null) && !isLoopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'only loopback requests are accepted' })
      return false
    }
    return true
  }
  /**
   * Wrap one handler with method checking and a JSON error contract.
   *
   * @param {string} method
   * @param {string} path
   * @param {(request: import('node:http').IncomingMessage, body: Record<string, unknown> | null) => Promise<object>} handler
   */
  const exact = (method, path, handler) => ({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (!allowed(request, response)) return
      const actual = String(request.method ?? 'GET').toUpperCase()
      if (actual !== method && !(method === 'GET' && actual === 'HEAD')) {
        sendJson(response, 405, { ok: false, error: `use ${method}` })
        return
      }
      let body = null
      if (method === 'POST') {
        if (writeAllowed(request) !== true) {
          sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
          return
        }
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, error?.code === 'TOO_LARGE' ? 413 : 400, {
            ok: false,
            error: String(error?.message ?? error),
          })
          return
        }
      }
      try {
        sendJson(response, 200, { ok: true, ...(await handler(request, body)) })
      } catch (error) {
        logger?.warn?.(`dsh-clarify: route ${path} failed: ${error?.message ?? error}`)
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendJson(response, status, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {Record<string, unknown> | null} body
   * @returns {string}
   */
  const sessionOf = (request, body) => {
    const fromBody = body !== null && typeof body.session === 'string' ? body.session.trim() : ''
    return fromBody === '' ? (query(request).get('session') ?? '').trim() : fromBody
  }

  /** @param {string} message */
  const badRequest = (message) => {
    const error = new Error(message)
    error.status = 400
    return error
  }

  /** @param {string} message */
  const conflict = (message) => {
    const error = new Error(message)
    error.status = 409
    return error
  }

  return [
    // Deliberately no `touch` here: /state is what the pill reads, and the pill
    // existing must not be mistaken for a panel that can answer questions.
    exact('GET', `${ROUTE_BASE}/state`, async (request) => {
      const session = sessionOf(request, null)
      return { session, ...store.view(session) }
    }),

    /**
     * What the panel needs on every poll: whether the mode is on, whether a card
     * is approved, and the questions currently waiting — all in one request, so
     * one timer serves both the pill and the panel.
     */
    exact('GET', `${ROUTE_BASE}/pending`, async (request) => {
      const session = sessionOf(request, null)
      if (session === '') throw badRequest('missing session')
      interview?.touch?.(session)
      const view = store.view(session)
      return {
        session,
        enabled: view.enabled,
        approved: view.approved,
        pending: interview?.pendingView?.(session) ?? null,
      }
    }),

    exact('POST', `${ROUTE_BASE}/answer`, async (request, body) => {
      const session = sessionOf(request, body)
      if (session === '') throw badRequest('missing session')
      const pendingId = typeof body?.id === 'string' ? body.id.trim() : ''
      if (pendingId === '') throw badRequest('missing id')
      const answers = normalizeAnswers(body?.answers)
      if (answers === null) throw badRequest('answers must be an array of { id, selected, custom }')
      const settled = interview?.answer?.(session, pendingId, answers) === true
      if (!settled) throw conflict('no pending question with that id (it may have expired or been answered)')
      return { session, settled: true }
    }),

    exact('POST', `${ROUTE_BASE}/cancel`, async (request, body) => {
      const session = sessionOf(request, body)
      if (session === '') throw badRequest('missing session')
      const pendingId = typeof body?.id === 'string' ? body.id.trim() : ''
      const reason = body?.reason === 'skipped' ? 'skipped' : 'dismissed'
      const settled = interview?.cancel?.(session, pendingId === '' ? undefined : pendingId, reason) === true
      if (!settled) throw conflict('no pending question to cancel')
      return { session, settled: true }
    }),

    exact('POST', `${ROUTE_BASE}/toggle`, async (request, body) => {
      const session = sessionOf(request, body)
      if (session === '') throw badRequest('missing session')
      const enabled = body?.enabled === true
      await store.setEnabled(session, enabled)
      return { session, ...store.view(session) }
    }),

    exact('POST', `${ROUTE_BASE}/clear`, async (request, body) => {
      const session = sessionOf(request, body)
      if (session === '') throw badRequest('missing session')
      await store.clearBrief(session)
      return { session, ...store.view(session) }
    }),

    /**
     * Sessions blocked on an answer right now, for the sidebar indicator.
     * Deliberately does not touch presence: it is not the panel speaking.
     */
    exact('GET', `${ROUTE_BASE}/waiting`, async () => ({ sessions: interview?.list?.() ?? [] })),

    exact('GET', `${ROUTE_BASE}/health`, async () => ({
      version,
      file: store.file,
      sessions: store.stats().sessions,
      enabled: store.stats().enabled,
      pending: interview?.stats?.().pending ?? 0,
      // How many approved cards the next interview can cite. Zero is normal on
      // a fresh install; a number that never moves means approvals are not landing.
      cards: preferences?.stats?.().count ?? 0,
      // Interview attempts recorded so far (all kinds and outcomes, `off`
      // included). The same number `node tools/stats.mjs` reports.
      interviews: metrics?.stats?.().count ?? 0,
      surfaces: surfaces ?? {},
    })),
  ]
}

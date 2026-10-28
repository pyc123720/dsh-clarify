/**
 * dsh-clarify — host half.
 *
 * The premise: a vague request costs more in rework than in questions. Turning
 * the mode on makes the agent do the cheap part first — restate the request,
 * ask the few questions whose answers change the plan, write a requirement card,
 * and get that card approved — before it writes a single file.
 *
 * The question panel is the product, so this half owns it end to end: the
 * ``/api/clarify`` routes serve the panel, the panel's answers settle a pending
 * interview, and that is what unblocks `clarify_ask`. The built-in question
 * channel remains as the fallback for hosts with no panel (TUI, headless), and
 * it is driven one question at a time.
 *
 * Five surfaces, every one optional to the composition:
 *
 *  - `systemPrompt` — the intake script (no approved card) or the approved card
 *    anchor, per session, rendered on every request while the mode is on;
 *  - `tools` — `clarify_ask` (the interview) and `clarify_brief` (the gate);
 *  - `webServer` — the panel and pill routes under `/api/clarify`;
 *  - `commands` — `/clarify [on|off|status]`, the keyboard path when no web GUI
 *    is composed at all.
 *
 * Nothing here imports `@deepseek-ai/*`: the seams are plain Cordis services,
 * so the plugin keeps loading across 0.2.x host releases without a rebuild.
 * Every surface is wired defensively — a missing service or a failed write can
 * only ever mean "this feature is unavailable", never a boot failure.
 *
 * @module dsh-clarify
 */

import path from 'node:path'

import { createInterview } from './interview.js'
import { createMetrics } from './metrics.js'
import { createPreferences, MAX_CARDS } from './preferences.js'
import { PROTOCOL, recentCardsDigest, sectionText } from './protocol.js'
import { createRoutes } from './routes.js'
import { createStateStore, resolveStatePath } from './state.js'
import { createTools } from './tools.js'
import { createWorkTracker } from './work-tracker.js'

/** Must equal `package.json`'s version. */
export const VERSION = '0.4.0'

/** Plugin id. Also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-clarify'

/** Applied when the profile's patch row gives no `config`. */
export const DEFAULTS = Object.freeze({
  storePath: '',
  sectionOrder: 3050,
  guidance: true,
  defaultEnabled: false,
  interviewTimeoutMs: 20 * 60 * 1000,
  cardFile: true,
  cardFileDir: '',
  interviewMode: 'full',
})

/**
 * Validate the patch config.
 *
 * Unknown keys are dropped with a warning rather than thrown: this runs during
 * boot, and a typo in a profile patch must not take the whole GUI down with it.
 *
 * @param {unknown} config
 * @param {object} [logger]
 * @returns {{ storePath: string, sectionOrder: number, guidance: boolean, defaultEnabled: boolean, interviewTimeoutMs: number, cardFile: boolean, cardFileDir: string, interviewMode: string }}
 */
export function resolveConfig(config, logger) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const known = new Set(Object.keys(DEFAULTS))
  const unknown = Object.keys(raw).filter(key => !known.has(key))
  if (unknown.length > 0) {
    try {
      logger?.warn?.(`dsh-clarify: ignoring unknown config key(s) ${unknown.join(', ')}`)
    } catch {
      /* logging must never be the failure */
    }
  }
  const storePath = typeof raw.storePath === 'string' ? raw.storePath.trim() : DEFAULTS.storePath
  const order = Number.isFinite(raw.sectionOrder) ? Number(raw.sectionOrder) : DEFAULTS.sectionOrder
  const timeout = Number.isSafeInteger(raw.interviewTimeoutMs) && raw.interviewTimeoutMs > 0
    ? raw.interviewTimeoutMs
    : DEFAULTS.interviewTimeoutMs
  return {
    storePath,
    sectionOrder: order,
    guidance: raw.guidance !== false,
    defaultEnabled: raw.defaultEnabled === true,
    interviewTimeoutMs: timeout,
    // Only an explicit `false` disables the write: a typo must not silently
    // stop a feature the person expects.
    cardFile: raw.cardFile !== false,
    cardFileDir: typeof raw.cardFileDir === 'string' ? raw.cardFileDir.trim() : DEFAULTS.cardFileDir,
    // Only an exact 'quick' opts out of the full interview; anything else is full.
    interviewMode: typeof raw.interviewMode === 'string' && raw.interviewMode.trim().toLowerCase() === 'quick'
      ? 'quick'
      : DEFAULTS.interviewMode,
  }
}

/**
 * The built-in question channel, normalized to the panel's result shape.
 *
 * This is the fallback: it is called **one question at a time** by the tools,
 * because the built-in UI gives a whole batch a single answer box.
 *
 * @param {object} ctx
 * @param {{ questions: object[], agent?: object, signal?: AbortSignal }} request
 * @returns {Promise<{ status: string, answers?: object[], note?: string }>}
 */
async function legacyAsk(ctx, { questions, agent, signal }) {
  const interaction = ctx.get?.('userQuestions')
  if (interaction === undefined || interaction === null || typeof interaction.ask !== 'function') {
    return { status: 'no_client', note: '这个 Host 没有 userQuestions 服务' }
  }
  if (agent === undefined) {
    return { status: 'no_client', note: '调用者不是可交互的 Agent（可能运行在子 Agent 里）' }
  }
  try {
    const answer = await interaction.ask({ questions, agent, signal })
    return { status: 'answered', answers: Array.isArray(answer?.answers) ? answer.answers : [] }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return { status: 'dismissed' }
    return { status: 'no_client', note: String(error?.message ?? error) }
  }
}

/**
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - The Loader row's `config`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config, ctx.logger)
  const store = createStateStore({
    file: resolveStatePath(resolved),
    logger: ctx.logger,
    defaultEnabled: resolved.defaultEnabled,
  })
  // The archive of approved cards lives next to the session state, so one folder
  // holds everything this plugin has to remember and one uninstall removes it.
  const preferences = createPreferences({
    file: path.join(path.dirname(store.file), 'cards.json'),
    logger: ctx.logger,
    maxCards: MAX_CARDS,
  })
  // Interview metrics are a local report, not telemetry: same folder, same rules.
  const metrics = createMetrics({
    file: path.join(path.dirname(store.file), 'metrics.json'),
    logger: ctx.logger,
  })
  // Whether a session has run a file-writing tool decides if goal questions are
  // still legitimate. Memory only: it is a fact about this process's history.
  const workTracker = createWorkTracker({ logger: ctx.logger })
  const interview = createInterview({
    logger: ctx.logger,
    timeoutMs: resolved.interviewTimeoutMs,
  })

  /** Surfaced by `/api/clarify/health`, so a silently missing surface is visible. */
  const surfaces = { section: false, tools: false, routes: 0, commands: false, error: '' }

  // Loading is best-effort and non-blocking: until the file lands every session
  // reads as "off", which is the safe direction to be wrong in.
  ctx.effect(() => {
    const failed = (label) => (error) => {
      surfaces.error = String(error?.message ?? error)
      try {
        ctx.logger?.warn?.(`dsh-clarify: ${label} not loaded: ${surfaces.error}`)
      } catch {
        /* nothing left to do */
      }
    }
    store.load().catch(failed('state file'))
    // A damaged archive is a warning, not an exception: the digest is optional.
    preferences.load().catch(failed('card archive'))
    metrics.load().catch(failed('metrics file'))
    return () => {
      // No tool call may stay suspended across an unload.
      interview.closeAll('unloaded')
    }
  }, 'dsh-clarify: state file')

  // Watching every session event is cheap — one Set insert per writing tool —
  // so the subscription is not gated on anything but the service existing.
  ctx.effect(() => {
    let off
    try {
      off = ctx.on?.('session/event', (session, event) => {
        workTracker.observe(session, event)
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-clarify: session events not observed: ${error?.message ?? error}`)
    }
    return () => {
      try {
        off?.()
      } catch {
        /* unloading must not throw */
      }
    }
  }, 'dsh-clarify: work tracker')

  if (resolved.guidance !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        const dispose = promptCtx.systemPrompt.section({
          name: 'dsh-clarify:protocol',
          order: resolved.sectionOrder,
          text: (assembly) => {
            const sessionId = assembly?.agent?.session?.id
            if (typeof sessionId !== 'string' || sessionId === '') return ''
            const section = sectionText(store.get(sessionId))
            // Only intake cites the archive: once a card is approved, that card is
            // the whole truth and an older one must not water it down.
            if (section !== PROTOCOL) return section
            const digest = recentCardsDigest(preferences.list())
            return digest === '' ? section : `${section}\n\n${digest}`
          },
        })
        surfaces.section = true
        return () => {
          surfaces.section = false
          try {
            dispose?.()
          } catch {
            /* unloading must not throw */
          }
        }
      } catch (error) {
        surfaces.error = String(error?.message ?? error)
        ctx.logger?.warn?.(`dsh-clarify: prompt section not registered: ${surfaces.error}`)
        return () => {}
      }
    })
  }

  ctx.inject(['tools'], (toolCtx) => {
    try {
      const definitions = createTools({
        store,
        interview,
        preferences,
        cardFile: resolved.cardFile,
        cardFileDir: resolved.cardFileDir,
        metrics,
        defaultMode: resolved.interviewMode,
        hasStartedWork: sessionId => workTracker.hasStartedWork(sessionId),
        legacyAsk: request => legacyAsk(ctx, request),
        logger: toolCtx.logger ?? ctx.logger,
      })
      const disposers = definitions.map(definition => toolCtx.tools.register(definition))
      surfaces.tools = true
      return () => {
        surfaces.tools = false
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* unloading must not throw */
          }
        }
      }
    } catch (error) {
      surfaces.error = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-clarify: tools not registered: ${surfaces.error}`)
      return () => {}
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    try {
      const routes = createRoutes({
        store,
        interview,
        preferences,
        metrics,
        version: VERSION,
        logger: webCtx.logger ?? ctx.logger,
        surfaces,
        // Read per request: the connection service can mount after this plugin.
        connection: () => ctx.get?.('connection'),
      })
      const disposers = routes.map(definition => webCtx.webServer.register(definition))
      surfaces.routes = disposers.length
      return () => {
        surfaces.routes = 0
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* unloading must not throw */
          }
        }
      }
    } catch (error) {
      surfaces.error = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-clarify: web routes not registered: ${surfaces.error}`)
      return () => {}
    }
  })

  ctx.inject(['commands'], (commandCtx) => {
    try {
      const dispose = commandCtx.commands.register({
        name: 'clarify',
        description: '开启/关闭澄清模式：开工前先问清需求，确认需求卡后再动手',
        input: { hint: '[on|off|status]' },
        handler: async ({ agent, rawInput }) => {
          const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
          if (sessionId === '') return { kind: 'error', text: '没有会话，无法切换澄清模式。' }
          const argument = String(rawInput ?? '').trim().toLowerCase()
          const current = store.view(sessionId)
          if (argument === 'status') return { kind: 'success', text: describe(current) }
          if (argument !== '' && argument !== 'on' && argument !== 'off') {
            return { kind: 'error', text: '用法：/clarify [on|off|status]（不带参数＝切换）' }
          }
          const enabled = argument === '' ? current.enabled !== true : argument === 'on'
          await store.setEnabled(sessionId, enabled)
          const next = store.view(sessionId)
          return { kind: 'success', text: describe(next) }
        },
      })
      surfaces.commands = true
      return () => {
        surfaces.commands = false
        try {
          dispose?.()
        } catch {
          /* unloading must not throw */
        }
      }
    } catch (error) {
      surfaces.error = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-clarify: /clarify command not registered: ${surfaces.error}`)
      return () => {}
    }
  })

  ctx.logger?.info?.(`dsh-clarify v${VERSION} 已挂载（state=${store.file} cards=${preferences.file} metrics=${metrics.file}）`)
}

/**
 * One line for the `/clarify` command.
 *
 * @param {{ enabled: boolean, approved: boolean }} view
 * @returns {string}
 */
export function describe(view) {
  if (view.enabled !== true) return '澄清模式：关。开工前不会先问需求；再执行 /clarify 打开。'
  return view.approved === true
    ? '澄清模式：开（需求卡已确认，按卡施工）。再执行 /clarify off 关闭。'
    : '澄清模式：开（下一轮会先把需求问清楚，再开工）。再执行 /clarify off 关闭。'
}

export default { name, apply }

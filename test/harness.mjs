/**
 * A deliberately small stand-in for the Cordis context and the four services
 * this plugin touches.
 *
 * It is not a Cordis emulator: `inject` runs the callback immediately when every
 * named service exists, which is enough to exercise wiring, degradation, and
 * the live objects the plugin keeps (a section provider, tool definitions,
 * route handlers, a command). Everything is inspectable afterwards, so a test
 * can assert what the model would actually read.
 *
 * @module dsh-clarify/test/harness
 */

/**
 * @param {{ omit?: string[], userQuestions?: object, connection?: object, now?: () => number }} [options]
 */
export function createFakeCtx(options = {}) {
  const omitted = new Set(options.omit ?? [])
  const warnings = []
  /** Event handlers registered with `ctx.on`. */
  const listeners = new Map()
  const state = {
    sections: [],
    tools: [],
    routes: [],
    commands: [],
    effects: [],
    warnings,
  }
  const logger = {
    info() {},
    debug() {},
    warn(...args) {
      warnings.push(args.map(String).join(' '))
    },
    error(...args) {
      warnings.push(args.map(String).join(' '))
    },
  }

  const remove = (list, value) => () => {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
  }

  /** @type {Record<string, object | undefined>} */
  const services = {
    systemPrompt: omitted.has('systemPrompt')
      ? undefined
      : {
        section(definition) {
          state.sections.push(definition)
          return remove(state.sections, definition)
        },
      },
    tools: omitted.has('tools')
      ? undefined
      : {
        register(definition) {
          state.tools.push(definition)
          return remove(state.tools, definition)
        },
      },
    webServer: omitted.has('webServer')
      ? undefined
      : {
        register(definition) {
          state.routes.push(definition)
          return remove(state.routes, definition)
        },
      },
    commands: omitted.has('commands')
      ? undefined
      : {
        register(definition) {
          state.commands.push(definition)
          return remove(state.commands, definition)
        },
      },
    userQuestions: options.userQuestions,
    connection: options.connection,
  }

  function makeContext() {
    return {
      logger,
      effect(fn) {
        const dispose = fn()
        state.effects.push(dispose)
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      inject(dependencies, callback) {
        const names = Array.isArray(dependencies) ? dependencies : [dependencies]
        if (!names.every(dep => services[dep] !== undefined)) return () => {}
        callback(makeContext())
        return () => {}
      },
      get(name) {
        return services[name]
      },
      on(name, handler) {
        if (typeof handler !== 'function') return () => {}
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
        return () => {
          const current = listeners.get(name) ?? []
          const index = current.indexOf(handler)
          if (index >= 0) current.splice(index, 1)
        }
      },
      ...services,
    }
  }

  const ctx = makeContext()

  const findRoute = path => state.routes.find(definition => definition.path === path)

  return {
    ctx,
    state,
    services,
    /** The section text for one fake assembly, or '' when no section exists. */
    sectionTextFor(agent) {
      const definition = state.sections.find(entry => entry.name === 'dsh-clarify:protocol')
      if (definition === undefined) return ''
      const text = definition.text
      return typeof text === 'function' ? text({ agent }) : String(text)
    },
    tool(name) {
      return state.tools.find(definition => definition.name === name)
    },
    /** Deliver one context event to every `ctx.on` handler, as the host would. */
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args)
    },
    route(path) {
      return findRoute(path)
    },
    /** Run one route against fake req/res; resolves to the captured response. */
    async call(path, { method = 'GET', url, headers = {}, body = '', remoteAddress } = {}) {
      const route = findRoute(path)
      if (route === undefined) throw new Error(`no route ${path}`)
      const request = fakeRequest({ method, url: url ?? path, headers, body, remoteAddress })
      const response = fakeResponse()
      await route.handler(request, response)
      return { ...response.out, json: response.json() }
    },
  }
}

/**
 * An async-iterable request whose socket is loopback, like a real same-machine call.
 *
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string }} init
 */
export function fakeRequest({ method = 'GET', url = '/', headers = {}, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3042', ...headers },
    socket: { remoteAddress },
    async* [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal ServerResponse capture. */
export function fakeResponse() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(payload) {
      out.body = typeof payload === 'string' ? payload : String(payload ?? '')
    },
    json() {
      return out.body === '' ? null : JSON.parse(out.body)
    },
  }
}

/**
 * The browser half has no DOM here, so this test covers the contracts that can
 * break without a browser: the module-loader registration, both slot
 * registrations, and the style effect. Rendering is verified in the GUI.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Minimal React stand-in: the factory only needs these names to exist. */
const ReactStub = {
  createElement(...args) {
    return { type: args[0], props: args[1], children: args[2] }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
  Fragment: Symbol('Fragment'),
}

function installDom() {
  const head = []
  const element = tag => ({
    tag,
    dataset: {},
    textContent: '',
    remove() {},
  })
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    baseURI: 'http://127.0.0.1:3042/',
    head: {
      appendChild(node) {
        head.push(node)
      },
    },
    createElement: element,
    getElementById() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  return head
}

test('the client bundle registers its style, the panel and the pill', async () => {
  const head = installDom()
  const loaded = []
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
  }

  await import('../lib/client.js?bundle')

  assert.equal(loaded.length, 1)
  const spec = loaded[0]
  assert.equal(spec.id, 'dsh-clarify')

  const plugin = spec.factory(name => {
    assert.equal(name, 'react')
    return ReactStub
  })
  assert.deepEqual(plugin.inject, ['slots'])

  const registered = []
  const injectedKeys = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
    },
    slots: {
      inject(key, callback) {
        injectedKeys.push(key)
        callback()
      },
      register(definition, component) {
        registered.push({ definition, component })
      },
    },
  }
  plugin.apply(ctx)

  assert.deepEqual(injectedKeys, ['conversation.input.dock', 'sidebar.footer.action', 'conversation.input.right'])
  assert.deepEqual(registered.map(entry => entry.definition.id), ['clarify-panel', 'clarify-waiting', 'clarify-mode'])
  assert.deepEqual(registered.map(entry => entry.definition.name), [
    'conversation.input.dock', 'sidebar.footer.action', 'conversation.input.right',
  ])
  assert.equal(registered.every(entry => typeof entry.component === 'function'), true)
  // One <style> element was installed and it is identifiable for replacement.
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-clarify-css')
  assert.ok(head[0].textContent.includes('.dclr-option'))
  const css = head[0].textContent
  // Themed fills only: a hardcoded foreground turns the submit button into a
  // white blob in the dark theme, where the brand fill is near-white.
  assert.ok(css.includes('--dsw-alias-button-primary-fill'))
  assert.ok(css.includes('--dsw-alias-label-primary-foreground'))
  assert.equal(css.includes('color:#fff'), false)
})

test('the panel bundle carries the quick/focus badges and the note hint', async () => {
  const head = installDom()
  const loaded = []
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
  }

  await import('../lib/client.js?badges')

  const plugin = loaded[0].factory(() => ReactStub)
  plugin.apply({
    effect(fn) {
      fn()
    },
    slots: {
      inject(key, callback) {
        callback()
      },
      register() {},
    },
  })

  const css = head[0].textContent
  assert.ok(css.includes('.dclr-tag'))
  assert.ok(css.includes('.dclr-note'))

  // There is no DOM here to render the panel into, so this half of the contract
  // is checked at the point where the browser would read it: the bundle source.
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // One entry per language dictionary, Chinese and English.
  assert.equal((source.match(/quickMode:/g) ?? []).length, 2)
  assert.equal((source.match(/focusPrefix:/g) ?? []).length, 2)
  assert.ok(source.includes("pending.mode === 'quick'"))
  assert.ok(source.includes("t('quickMode')"))
  assert.ok(source.includes("t('focusPrefix')"))
  assert.ok(source.includes("className: 'dclr-tag'"))
  assert.ok(source.includes("className: 'dclr-note'"))
})

/**
 * Approved requirement cards, remembered across sessions.
 *
 * The last few cards a person approved are the cheapest possible draft of the
 * next interview: instead of asking the same six questions again, the agent can
 * open with "上次是《…》，这次哪里不同？". The Ask-Less work measures that step
 * as roughly 13% off the remaining attention cost, but only if the archive is
 * boring infrastructure — it must never lose the newest write, never throw
 * while a prompt is being assembled, and never grow without bound.
 *
 * So this module repeats the two rules that `./state.js` keeps:
 *
 *  - **Writes are serialized and atomic.** Approval arrives from the tool (and,
 *    later, from the panel); every mutation runs through one promise chain and
 *    lands via a temp file + rename, so a reader never sees half a document.
 *  - **A damaged file degrades to "no memory".** Missing, unreadable, or invalid
 *    JSON is a warning, not an exception: clarify still works, it just cannot
 *    cite last time's card. The bad file is left in place so nothing is
 *    destroyed before someone can look at it.
 *
 * Unlike `state.js` there is no synchronous read path: the prompt section that
 * cites a past card already awaits during assembly, and `list()` is a plain
 * in-memory read after that.
 *
 * @module dsh-clarify/preferences
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveHomeDir } from './state.js'

/** Document version. Unknown versions are still read field-by-field. */
export const SCHEMA_VERSION = 1

/** Cards kept on disk; the least recently approved ones are dropped. */
export const MAX_CARDS = 8

/** A title is one short line in a picker, not a paragraph. */
export const TITLE_LIMIT = 60

/** Used when a card has no readable heading or line to name itself with. */
export const FALLBACK_TITLE = '需求卡'

/** Correlation counter for temp files; the write chain already serializes them. */
let tempCounter = 0

/** Correlation counter for card ids. Not a security boundary. */
let cardCounter = 0

/**
 * @returns {string} short, collision-free id for a freshly remembered card
 */
function nextCardId() {
  cardCounter += 1
  return `card-${Date.now().toString(36)}-${cardCounter.toString(36)}`
}

/**
 * An explicit `file` wins; otherwise `$DSH_HOME/clarify/preferences.json`.
 * Sitting next to `state.json` means uninstalling the plugin deletes one folder,
 * not two unrelated ones.
 *
 * @param {{ file?: string }} [config]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute path
 */
export function resolvePreferencesPath(config = {}, env = process.env) {
  const configured = typeof config.file === 'string' ? config.file.trim() : ''
  if (configured !== '') return path.resolve(configured)
  return path.join(resolveHomeDir(env), 'clarify', 'preferences.json')
}

/**
 * Strip the markdown scaffolding that a card line may carry, so a title is text
 * rather than syntax. Kept deliberately narrow: it removes structure markers,
 * never words.
 *
 * @param {string} line
 * @returns {string} the line, collapsed to one line, on one line
 */
function plainLine(line) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s*|>\s*|[-*+]\s+|\d{1,2}[.)]\s+)+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cut to `TITLE_LIMIT` code points, so an emoji or a surrogate pair is never
 * split in half.
 *
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const characters = Array.from(text)
  return characters.length <= TITLE_LIMIT ? text : characters.slice(0, TITLE_LIMIT).join('')
}

/**
 * Name a card: an explicit title wins, then the first heading, then the first
 * non-empty line, then {@link FALLBACK_TITLE}.
 *
 * `first line` is not tried before the heading because cards written by this
 * plugin start with `# …`; when they do not, the first line is the only thing
 * that could plausibly name them.
 *
 * @param {string} card
 * @param {string} [title]
 * @returns {string}
 */
export function deriveTitle(card, title = '') {
  const explicit = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  if (explicit !== '') return truncate(explicit)

  const text = typeof card === 'string' ? card : ''
  const lines = text.split(/\r?\n/)
  const heading = lines.find(line => /^\s{0,3}#{1,6}\s+\S/.test(line))
  const fallback = heading ?? lines.find(line => line.trim() !== '')
  const plain = fallback === undefined ? '' : plainLine(fallback)
  return plain === '' ? FALLBACK_TITLE : truncate(plain)
}

/**
 * Salvage one stored row. A row without card text is dropped rather than kept
 * as a blank entry, because the one thing this archive is for is the text.
 *
 * @param {unknown} raw
 * @returns {{ id: string, title: string, card: string, approvedAt: number, sessionId: string } | null}
 */
export function normalizeCard(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const card = typeof source.card === 'string' ? source.card : ''
  if (card.trim() === '') return null
  const storedId = typeof source.id === 'string' ? source.id.trim() : ''
  return {
    id: storedId === '' ? nextCardId() : storedId,
    title: deriveTitle(card, typeof source.title === 'string' ? source.title : ''),
    card,
    approvedAt: Number.isFinite(source.approvedAt) ? Number(source.approvedAt) : 0,
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : '',
  }
}

/**
 * @typedef {object} CardRecord
 * @property {string} id - Stable for the lifetime of one card text; survives re-approval.
 * @property {string} title - Picker-sized name, derived when the caller has none.
 * @property {string} card - The approved requirement card, trimmed, verbatim otherwise.
 * @property {number} approvedAt - `now()` at the latest approval.
 * @property {string} sessionId - Session that approved it; `''` when unknown.
 *
 * @typedef {object} PreferenceStore
 * @property {() => Promise<void>} load
 * @property {() => CardRecord[]} list
 * @property {(input?: { card?: unknown, title?: string, sessionId?: string }) => Promise<CardRecord | null>} remember
 * @property {() => Promise<void>} clear
 * @property {() => { count: number }} stats
 * @property {string} file
 */

/**
 * @param {{ file?: string, logger?: object, now?: () => number, maxCards?: number }} [options]
 * @returns {PreferenceStore}
 */
export function createPreferences({ file, logger, now = () => Date.now(), maxCards = MAX_CARDS } = {}) {
  const target = typeof file === 'string' && file.trim() !== '' ? file : resolvePreferencesPath()
  const limit = Number.isSafeInteger(maxCards) && maxCards > 0 ? maxCards : MAX_CARDS

  /**
   * Newest first. The head is what the next interview cites.
   * @type {CardRecord[]}
   */
  let cards = []
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
    const text = `${JSON.stringify({ version: SCHEMA_VERSION, cards }, null, 2)}\n`
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
   * `load()` runs first, memoized, so a caller that forgets to load cannot
   * overwrite the archive with only the card it is remembering.
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
   * Read the archive once. The result is memoized: a second call is free and —
   * more importantly — can never discard cards approved in this process after
   * the first read. A missing, unreadable, or invalid file leaves the archive
   * empty instead of throwing.
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
        warn(`${target} is not valid JSON; starting with no memory (the file is kept)`, error)
        return
      }
      // Accept a bare array too: an older or hand-written file is still readable.
      const rows = Array.isArray(document)
        ? document
        : document !== null && typeof document === 'object' && Array.isArray(document.cards)
          ? document.cards
          : []
      const restored = []
      for (const raw of rows) {
        const entry = normalizeCard(raw)
        if (entry !== null) restored.push(entry)
      }
      cards = restored.slice(0, limit)
      if (restored.length > limit) {
        warn(`kept ${limit} of ${restored.length} card(s) from ${target}`)
      }
    })()
    return loadPromise
  }

  function list() {
    // Copies, so a prompt builder that sorts its input cannot reorder the store.
    return cards.map(entry => ({ ...entry }))
  }

  function remember(input = {}) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const raw = typeof source.card === 'string' ? source.card.trim() : ''
    // A blank card is not an approval; refusing it early also keeps `load()`
    // from being triggered for a write that will not happen.
    if (raw === '') return Promise.resolve(null)
    const title = typeof source.title === 'string' ? source.title : ''
    const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''

    return write(() => {
      const approvedAt = now()
      const previousIndex = cards.findIndex(entry => entry.card === raw)
      const previous = previousIndex === -1 ? null : cards[previousIndex]
      const entry = {
        // The id outlives re-approval: the panel and the next interview refer to
        // a card by id, and the same text is the same card to a person.
        id: previous === null ? nextCardId() : previous.id,
        title: deriveTitle(raw, title),
        card: raw,
        approvedAt,
        // An unnamed re-approval keeps the session that originally approved it.
        sessionId: sessionId === '' && previous !== null ? previous.sessionId : sessionId,
      }
      const rest = previous === null ? cards : cards.filter((_, index) => index !== previousIndex)
      cards = [entry, ...rest].slice(0, limit)
      return { ...entry }
    })
  }

  function clear() {
    return write(() => {
      cards = []
    })
  }

  return {
    file: target,
    load,
    list,
    remember,
    clear,
    stats() {
      return { count: cards.length }
    },
  }
}

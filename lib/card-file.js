/**
 * The approved requirement card, as a file in the workspace.
 *
 * `state.js` keeps the card where the plugin can read it back; this module
 * writes the same card where *people* and *diffs* can read it. One markdown
 * file per approval under `<cwd>/.dsh/clarify/` means the card can be reviewed
 * in a PR, handed to another agent, and found again by the next session — a
 * minimal spec-first trail instead of a hidden JSON row.
 *
 * Three rules this writer owes its callers:
 *
 *  - **The title is not the body.** The file starts with exactly one H1, so a
 *    card is scannable at a glance; a leading heading in the body that merely
 *    repeats that title is dropped rather than written twice.
 *  - **Names are portable.** File names keep Chinese and lose what Windows
 *    refuses (`<>:"/\|?*`) and every control character; blank input falls back
 *    to `brief` so a nameless card still gets a name.
 *  - **A write is all or nothing.** Content lands via a temp file + rename, so a
 *    crash can leave a stray temp file behind but never a half-written card.
 *
 * @module dsh-clarify/card-file
 */

import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Longest file-name fragment `slugify` keeps before truncating. */
export const MAX_SLUG_CHARS = 48

/** H1 used when neither the caller nor the card supplies a title. */
export const DEFAULT_CARD_TITLE = '需求卡'

/** Windows refuses these anywhere in a name; the POSIX separator included. */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/g

/** POSIX tolerates control characters in a name, Windows does not. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** A body that opens with a markdown heading, captured for the title. */
const LEADING_HEADING = /^#{1,6}[ \t]+([^\n]+?)[ \t]*(?:\n+|$)/

/**
 * Turn arbitrary text into one portable file-name fragment.
 *
 * Chinese (and any other non-ASCII letter) survives untouched — this plugin is
 * Chinese-first, and a requirement card titled 「季度报告」 must not become a
 * row of underscores. Collisions from removed characters are deliberate: the
 * timestamp prefix and the `-2` suffix keep names unique, and a short readable
 * name beats an escape sequence no one can type.
 *
 * @param {unknown} value - Title-ish text.
 * @param {number} [max] - Longest fragment kept (code points, default 48).
 * @returns {string} a non-empty, portable fragment
 */
export function slugify(value, max = MAX_SLUG_CHARS) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : MAX_SLUG_CHARS
  const text = typeof value === 'string' ? value : ''
  const cleaned = text
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_NAME_CHARS, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const kept = [...cleaned].slice(0, limit).join('').replace(/^[-.]+|[-.]+$/g, '')
  return kept === '' ? 'brief' : kept
}

/**
 * Where approved cards live for one session.
 *
 * An explicit `config.cardFileDir` wins so a deployment can point every
 * session at one shared folder; otherwise the card belongs to the project it
 * was approved for, under `<cwd>/.dsh/clarify`.
 *
 * @param {{ cwd?: unknown, config?: unknown }} [options]
 * @param {unknown} [options.cwd] - Session working directory.
 * @param {{ cardFileDir?: unknown }} [options.config] - Plugin config.
 * @returns {string} absolute directory, or `''` when there is no cwd to anchor to
 */
export function resolveCardDir(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const config = source.config !== null && typeof source.config === 'object' ? source.config : {}
  const configured = typeof config.cardFileDir === 'string' ? config.cardFileDir.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const cwd = typeof source.cwd === 'string' ? source.cwd.trim() : ''
  if (cwd === '') return ''
  return path.resolve(cwd, '.dsh', 'clarify')
}

/**
 * @typedef {object} WriteCardOptions
 * @property {string} dir - Directory to write into; created recursively.
 * @property {unknown} card - The approved card body (markdown).
 * @property {unknown} [title] - Explicit title. When absent, the card's leading
 *   heading is used; when that is absent too, {@link DEFAULT_CARD_TITLE}.
 * @property {unknown} [approvedAt] - Approval stamp: epoch ms, `Date`, or a
 *   parseable date string. Defaults to `now()`.
 * @property {() => number | Date} [now] - Clock, injectable for tests.
 * @property {unknown} [sessionId] - Session that approved the card.
 */

/**
 * @typedef {object} WriteCardResult
 * @property {string} path - Absolute path of the written card.
 * @property {number} bytes - UTF-8 bytes actually written.
 */

/**
 * Write one approved card as `card-YYYYMMDD-HHMM-<slug>.md`.
 *
 * The stamp in the file is an unambiguous ISO instant; the stamp in the name is
 * the local wall-clock minute, because a person looking at a folder thinks in
 * local time. Two cards approved by the same title within one minute are
 * sequential, so the writer appends `-2`, `-3`, … instead of overwriting.
 *
 * @param {WriteCardOptions} [options]
 * @returns {Promise<WriteCardResult>}
 * @throws {Error} `empty card` when the body is blank, `empty card dir` when no
 *   destination was supplied
 */
export async function writeCard(options = {}) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const body = normalizeBody(source.card)
  if (body === '') throw new Error('empty card')

  const targetDir = typeof source.dir === 'string' ? source.dir.trim() : ''
  if (targetDir === '') throw new Error('empty card dir')

  const heading = LEADING_HEADING.exec(body)
  const headingTitle = heading === null ? '' : normalizeTitle(heading[1])
  const explicit = normalizeTitle(source.title)
  const title = explicit !== '' ? explicit : headingTitle !== '' ? headingTitle : DEFAULT_CARD_TITLE
  // A body heading identical to the title is the same words twice — drop it.
  const content = headingTitle !== '' && headingTitle === title
    ? body.slice(heading[0].length).replace(/^\n+/, '')
    : body

  const at = resolveInstant(source.approvedAt, source.now)
  const session = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''
  const text = renderCard(title, at, session, content)
  const stem = `card-${stampOf(at)}-${slugify(title)}`

  const directory = path.resolve(targetDir)
  await mkdir(directory, { recursive: true })
  const file = await uniquePath(directory, stem)
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { path: file, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * @param {unknown} value - Raw `card` argument.
 * @returns {string} normalized markdown body, `''` when unusable
 */
function normalizeBody(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

/**
 * @param {unknown} value - Raw `title` argument.
 * @returns {string} single-line title, `''` when unusable
 */
function normalizeTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * The exact file contents: one H1, the provenance lines, then the card.
 *
 * @param {string} title
 * @param {Date} at
 * @param {string} sessionId
 * @param {string} body
 * @returns {string} markdown ending in exactly one newline
 */
function renderCard(title, at, sessionId, body) {
  const header = [
    `# ${title}`,
    '',
    `- 批准时间：${at.toISOString()}`,
    `- 会话：${sessionId === '' ? '（无）' : sessionId}`,
  ].join('\n')
  return body === '' ? `${header}\n` : `${header}\n\n${body}\n`
}

/**
 * Resolve `approvedAt` without ever guessing from a broken clock.
 *
 * @param {unknown} approvedAt - Epoch ms, `Date`, or parseable date string.
 * @param {unknown} now - Injected clock.
 * @returns {Date}
 */
function resolveInstant(approvedAt, now) {
  if (approvedAt instanceof Date && Number.isFinite(approvedAt.getTime())) return approvedAt
  if (Number.isFinite(approvedAt)) return new Date(Number(approvedAt))
  if (typeof approvedAt === 'string') {
    const parsed = new Date(approvedAt)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  let value
  try {
    value = typeof now === 'function' ? now() : Date.now()
  } catch {
    value = Date.now()
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  return new Date(Number.isFinite(value) ? Number(value) : Date.now())
}

/**
 * Local `YYYYMMDD-HHMM` for the name — the minute a person will look for.
 *
 * @param {Date} at
 * @returns {string}
 */
function stampOf(at) {
  const pad = number => String(number).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}`
}

/**
 * First free `<stem>.md`, then `<stem>-2.md`, `<stem>-3.md`, …
 *
 * One plugin process writes one card per approval, so an existence check is
 * enough; a collision that slips through would still never truncate a card
 * because the write itself is a rename.
 *
 * @param {string} directory
 * @param {string} stem
 * @returns {Promise<string>} absolute path
 */
async function uniquePath(directory, stem) {
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${stem}.md` : `${stem}-${index}.md`
    const candidate = path.join(directory, name)
    if (!(await exists(candidate))) return candidate
    if (index >= 999) throw new Error(`too many cards named ${stem}`)
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

#!/usr/bin/env node
/**
 * Append (or remove) a package name in a DSH profile's `dsh.profile.bundles`.
 *
 * `pnpm add` already writes the dependency; it knows nothing about the bundle
 * list, and a package that is installed but missing from that list is silently
 * never composed. This is that second half, kept as a tiny script so the
 * install flow has no PowerShell JSON round-trip in it.
 *
 * Usage: node add-bundle.mjs <profile/package.json> <name> [<name>…] [--remove] [--dry-run]
 * Prints one JSON line: { "ok": true, "changed": [...], "before": [...], "bundles": [...] }
 */
import { readFile, writeFile } from 'node:fs/promises'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(argument => argument.startsWith('--')))
const positional = argv.filter(argument => !argument.startsWith('--'))
const [packagePath, ...names] = positional

if (packagePath === undefined || names.length === 0) {
  console.error('usage: node add-bundle.mjs <profile/package.json> <name> [<name>…] [--remove] [--dry-run]')
  process.exit(2)
}

const wantsRemove = flags.has('--remove')
const dryRun = flags.has('--dry-run')

const raw = await readFile(packagePath, 'utf8')
let document
try {
  document = JSON.parse(raw)
} catch (error) {
  console.error(`${packagePath} is not valid JSON: ${error.message}`)
  process.exit(1)
}

const profile = document?.dsh?.profile
if (profile === null || typeof profile !== 'object') {
  console.error(`${packagePath} has no dsh.profile object; is this really a DSH profile?`)
  process.exit(1)
}
if (!Array.isArray(profile.bundles)) profile.bundles = []

const before = [...profile.bundles]
const changed = []

for (const name of names) {
  const at = profile.bundles.indexOf(name)
  if (wantsRemove) {
    if (at >= 0) {
      profile.bundles.splice(at, 1)
      changed.push(name)
    }
  } else if (at < 0) {
    profile.bundles.push(name)
    changed.push(name)
  }
}

if (changed.length > 0 && !dryRun) {
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  mode: wantsRemove ? 'remove' : 'add',
  changed,
  before,
  bundles: profile.bundles,
}))

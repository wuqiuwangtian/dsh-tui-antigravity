import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE = 'prefs.json'
const LEGACY_LAST_SESSION = 'last-session'
const FIELDS = ['model', 'effort', 'mode', 'lastSession']

function parse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of FIELDS) {
    if (typeof raw[key] === 'string' && raw[key] !== '') out[key] = raw[key]
  }
  return out
}

function patched(current, patch) {
  const next = { ...current }
  for (const key of FIELDS) {
    const value = patch[key]
    if (value === undefined) continue
    if (value === null || value === '') delete next[key]
    else if (typeof value === 'string') next[key] = value
  }
  return next
}

export function filePrefs(dir, debug = () => {}) {
  const file = join(dir, FILE)
  const legacyFile = join(dir, LEGACY_LAST_SESSION)
  function read() {
    let data = {}
    try {
      data = parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {}
    if (!data.lastSession) {
      try {
        const legacy = readFileSync(legacyFile, 'utf8').trim()
        if (legacy) data.lastSession = legacy
      } catch {}
    }
    return data
  }
  function save(next, clearLegacy) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temp = file + '.' + randomUUID() + '.tmp'
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      renameSync(temp, file)
      if (clearLegacy) {
        try { unlinkSync(legacyFile) } catch {}
      }
    } catch (error) {
      debug('antigravity: prefs write failed (' + (error instanceof Error ? error.message : String(error)) + ')')
    }
  }
  return {
    read,
    write(patch) {
      const clearLegacy = Object.hasOwn(patch, 'lastSession') && !patch.lastSession
      save(patched(read(), patch), clearLegacy)
    },
  }
}

export function memoryPrefs(initial = {}) {
  let data = parse(initial)
  return {
    read: () => ({ ...data }),
    write(patch) { data = patched(data, patch) },
  }
}

export function createPrefs(host) {
  return host?.dataDir ? filePrefs(host.dataDir, host.debug) : memoryPrefs()
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { connect, executable } from './connection.js'
import { Session } from './session.js'

const run = promisify(execFile)

async function list(scope = {}, onPartial) {
  const cwd = resolve(scope.cwd ?? process.cwd())
  const rpc = await connect(cwd)
  try {
    const rows = []
    const cursors = new Set()
    let cursor
    do {
      const page = await rpc.request('session/list', { cwd: scope.allProjects ? undefined : cwd, cursor }, { signal: AbortSignal.timeout(20000) })
      for (const s of page.sessions) {
        if (!scope.allProjects && (!s.cwd || resolve(s.cwd) !== cwd)) continue
        const updatedAt = Date.parse(s.updatedAt) || 0
        rows.push({ id: s.sessionId, backendId: 'antigravity', kind: { kind: 'root' },
          title: { text: s.title || s.sessionId, source: 'auto' }, cwd: s.cwd, updatedAt,
          createdAt: updatedAt, hasPrompt: true, childCount: 0 })
      }
      onPartial?.([...rows])
      cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('Repeated ACP catalog cursor')
      cursors.add(cursor)
    } while (cursor)
    return rows
  } finally { await rpc.close() }
}

export const backend = {
  id: 'antigravity',
  descriptor: { label: 'Antigravity' },
  async detect() {
    try {
      const { stdout } = await run(executable(), ['--version'], { timeout: 5000 })
      await run(executable(), ['acp', '--help'], { timeout: 5000 })
      return { installed: true, version: stdout.trim(), auth: 'unknown' }
    } catch { return { installed: false, hint: 'Install Antigravity CLI with ACP support (agy acp --help).' } }
  },
  launch: {
    sessionPrefs(host) {
      const file = host.dataDir && join(host.dataDir, 'last-session')
      let recent
      function lastSession() {
        if (file) {
          try { return readFileSync(file, 'utf8').trim() || undefined } catch {}
        }
        return recent
      }
      function setLastSession(id) {
        recent = id
        if (!file) return
        mkdirSync(host.dataDir, { recursive: true })
        const temp = file + '.' + randomUUID()
        writeFileSync(temp, id, { mode: 0o600 })
        renameSync(temp, file)
      }
      return { lastSession, setLastSession, touch: setLastSession,
        forget(id) { if (lastSession() === id) setLastSession('') } }
    },
    resumeCommand(id) {
      const quoted = String(id).replaceAll("'", "'\\''")
      return "dsh-tui --backend antigravity --resume '" + quoted + "'"
    },
  },
  catalog: { list, async info(id, cwd) { return (await list({ cwd, allProjects: !cwd })).find(s => s.id === id) } },
  async open(target, host) {
    let cwd = target.cwd
    if (target.kind === 'resume') {
      // agy 1.5.9 may acknowledge session/load for a nonexistent UUID.
      // Verify membership before asking it to open anything.
      const row = await backend.catalog.info(target.sessionId, cwd)
      if (!row?.cwd) throw new Error('Cannot locate this session in the native Antigravity catalog.')
      cwd = row.cwd
    }
    const session = new Session(resolve(cwd))
    await session.open(target)
    return session
  },
}
export default function antigravityBundle() {}

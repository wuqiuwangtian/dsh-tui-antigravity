import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { connect, executable } from './connection.js'
import { Session } from './session.js'

const run = promisify(execFile)
// One explicit preset choice applies to the next new conversation in this workspace.
const nextAgents = new Map()

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
      return { installed: true, version: stdout.trim(), auth: 'unknown', loginInSession: true }
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
        if (id.startsWith('signin-')) return
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
  catalog: {
    list,
    deleteHint: {
      zh: '在会话所属目录运行 agy，输入 /resume，选中对话后按 F4，核对标题并按 Y 确认。',
      en: 'Run agy in the conversation directory. Enter /resume, select the conversation, press F4, check the title and confirm with Y.',
    },
    async info(id, cwd) { return (await list({ cwd, allProjects: !cwd })).find(s => s.id === id) },
  },
  async open(target, host) {
    let cwd = target.cwd
    if (target.kind === 'resume') {
      // agy 1.5.9 may acknowledge session/load for a nonexistent UUID.
      // Verify membership before asking it to open anything.
      let row
      try { row = await backend.catalog.info(target.sessionId, cwd) }
      catch (error) {
        if (error.code !== -32000) throw error
        const session = new Session(resolve(cwd ?? host.cwd))
        session.enterLogin(target)
        return session
      }
      if (!row?.cwd) throw new Error('Cannot locate this session in the native Antigravity catalog.')
      cwd = row.cwd
    }
    const dir = resolve(cwd)
    const agent = target.kind === 'create' ? nextAgents.get(dir) : undefined
    const session = new Session(dir, { agent, stageAgent: name => nextAgents.set(dir, name) })
    await session.open(target)
    if (!session.needsLogin && agent && nextAgents.get(dir) === agent) nextAgents.delete(dir)
    return session
  },
}
export default function antigravityBundle() {}

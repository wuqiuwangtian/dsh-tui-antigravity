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

async function* catalogPages(rpc, cwd) {
  const cursors = new Set()
  let cursor
  do {
    const page = await rpc.request('session/list', { cwd, cursor }, { signal: AbortSignal.timeout(20000) })
    yield page.sessions.filter(row => !cwd || (row.cwd && resolve(row.cwd) === cwd))
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('Repeated ACP catalog cursor')
    cursors.add(cursor)
  } while (cursor)
}

function summary(s) {
  const updatedAt = Date.parse(s.updatedAt) || 0
  return { id: s.sessionId, backendId: 'antigravity', kind: { kind: 'root' },
    title: { text: s.title || s.sessionId, source: 'auto' }, cwd: s.cwd, updatedAt,
    createdAt: updatedAt, hasPrompt: true, childCount: 0 }
}

async function findSession(rpc, id, cwd) {
  for await (const page of catalogPages(rpc, cwd)) {
    const row = page.find(s => s.sessionId === id)
    if (row) return row
  }
}

async function list(scope = {}, onPartial) {
  const cwd = resolve(scope.cwd ?? process.cwd())
  const rpc = await connect(cwd)
  try {
    const rows = []
    for await (const page of catalogPages(rpc, scope.allProjects ? undefined : cwd)) {
      for (const item of page) rows.push(summary(item))
      onPartial?.([...rows])
    }
    return rows
  } finally {
    // This read-only child has no session locks. Signal it now, reap it in the background.
    void rpc.close()
  }
}

function workspaceSession(dir, agent) {
  return new Session(dir, { agent, stageAgent: name => nextAgents.set(dir, name) })
}

async function resume(target, dir) {
  const session = workspaceSession(dir)
  let rpc
  try {
    rpc = await session.connectAgent()
    // agy may acknowledge a load for a nonexistent ID. Check the live catalog on the
    // same authenticated connection that will replay history.
    const row = await findSession(rpc, target.sessionId, target.cwd ? dir : undefined)
    if (!row?.cwd) throw new Error('Cannot locate this session in the native Antigravity catalog.')
    const workspace = resolve(row.cwd)
    if (workspace !== dir) {
      // The child must run in the original workspace for tools and project settings.
      void rpc.close()
      return resume({ ...target, cwd: workspace }, workspace)
    }
  } catch (error) {
    await rpc?.close()
    if (error.code !== -32000) throw error
    session.enterLogin(target)
    return session
  }
  await session.open(target, rpc)
  return session
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
    if (target.kind === 'resume') return resume(target, resolve(target.cwd ?? host.cwd ?? process.cwd()))
    const dir = resolve(target.cwd)
    const agent = nextAgents.get(dir)
    const session = workspaceSession(dir, agent)
    await session.open(target)
    if (!session.needsLogin && agent && nextAgents.get(dir) === agent) nextAgents.delete(dir)
    return session
  },
}
export default function antigravityBundle() {}

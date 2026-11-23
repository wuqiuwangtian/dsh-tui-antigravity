import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect, executable, normalizeWorkspaceCwd } from './connection.js'
import { createPrefs } from './prefs.js'
import { Session } from './session.js'

export { normalizeWorkspaceCwd }

const run = promisify(execFile)
// One explicit preset choice applies to the next new conversation in this workspace.
const nextAgents = new Map()

function isDirectory(path) {
  if (!path) return false
  try { return statSync(path).isDirectory() } catch { return false }
}

async function* rawCatalogPages(rpc, cwd) {
  const cursors = new Set()
  let cursor
  do {
    const page = await rpc.request('session/list', { cwd, cursor }, { signal: AbortSignal.timeout(20000) })
    const sessions = Array.isArray(page?.sessions) ? page.sessions : []
    yield sessions.map(row => row?.cwd ? { ...row, cwd: normalizeWorkspaceCwd(row.cwd) } : row)
    cursor = page?.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('Repeated ACP catalog cursor')
    cursors.add(cursor)
  } while (cursor)
}

async function* catalogPages(rpc, cwd) {
  let matched = false
  for await (const page of rawCatalogPages(rpc, cwd)) {
    const filtered = page.filter(row => !cwd || (row.cwd && resolve(row.cwd) === cwd))
    if (filtered.length) matched = true
    yield filtered
  }
  // agy may store percent-encoded file:// URIs internally and miss a server-side
  // cwd filter for non-ASCII paths. Fall back to local filtering when needed.
  if (cwd && !matched && encodeURI(cwd) !== cwd) {
    for await (const page of rawCatalogPages(rpc, undefined)) {
      yield page.filter(row => row.cwd && resolve(row.cwd) === cwd)
    }
  }
}

function summary(s) {
  const updatedAt = Date.parse(s.updatedAt) || 0
  return { id: s.sessionId, backendId: 'antigravity', kind: { kind: 'root' },
    title: { text: s.title || s.sessionId, source: 'auto' }, cwd: normalizeWorkspaceCwd(s.cwd), updatedAt,
    createdAt: updatedAt, hasPrompt: true, childCount: 0 }
}

async function findSession(rpc, id, cwd) {
  for await (const page of catalogPages(rpc, cwd)) {
    const row = page.find(s => s.sessionId === id)
    if (row) return row
  }
  if (cwd) {
    for await (const page of catalogPages(rpc, undefined)) {
      const row = page.find(s => s.sessionId === id)
      if (row) return row
    }
  }
}

async function list(scope = {}, onPartial) {
  const requested = resolve(normalizeWorkspaceCwd(scope.cwd) ?? process.cwd())
  const spawnCwd = isDirectory(requested) ? requested : process.cwd()
  const rpc = await connect(spawnCwd)
  try {
    const rows = []
    for await (const page of catalogPages(rpc, scope.allProjects ? undefined : requested)) {
      for (const item of page) rows.push(summary(item))
      onPartial?.([...rows])
    }
    return rows
  } finally {
    // This read-only child has no session locks. Signal it now, reap it in the background.
    void rpc.close()
  }
}

function workspaceSession(dir, agent, prefs) {
  return new Session(dir, { agent, stageAgent: name => nextAgents.set(dir, name), prefs })
}

async function resume(target, dir, prefs) {
  const spawnDir = isDirectory(dir) ? dir : process.cwd()
  const session = workspaceSession(spawnDir, undefined, prefs)
  let rpc
  try {
    rpc = await session.connectAgent()
    // agy may acknowledge a load for a nonexistent ID. Check the live catalog on the
    // same authenticated connection that will replay history.
    const row = await findSession(rpc, target.sessionId, target.cwd ? spawnDir : undefined)
    if (!row) throw new Error('Cannot locate this session in the native Antigravity catalog.')
    const workspace = row.cwd ? resolve(normalizeWorkspaceCwd(row.cwd)) : spawnDir
    if (workspace !== spawnDir && isDirectory(workspace)) {
      // The child must run in the original workspace for tools and project settings.
      void rpc.close()
      return resume({ ...target, cwd: workspace }, workspace, prefs)
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
      const prefs = createPrefs(host)
      const lastSession = () => prefs.read().lastSession
      const setLastSession = id => {
        if (typeof id !== 'string' || id.startsWith('signin-')) return
        prefs.write({ lastSession: id || null })
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
  async open(target, host = {}) {
    const prefs = createPrefs(host)
    if (target.kind === 'resume') {
      const initial = resolve(normalizeWorkspaceCwd(target.cwd) ?? host.cwd ?? process.cwd())
      return resume(target, initial, prefs)
    }
    const dir = resolve(normalizeWorkspaceCwd(target.cwd))
    const agent = nextAgents.get(dir)
    const session = workspaceSession(dir, agent, prefs)
    await session.open(target)
    if (!session.needsLogin && agent && nextAgents.get(dir) === agent) nextAgents.delete(dir)
    return session
  },
}
export default function antigravityBundle() {}

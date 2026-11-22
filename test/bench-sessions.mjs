// Opt-in lifecycle benchmark. Uses an isolated home and at most one short model turn.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { backend } from '../backend.js'
import { connect } from '../connection.js'

async function timed(label, run) {
  const start = performance.now()
  const value = await run()
  console.log(label, Math.round(performance.now() - start), 'ms')
  return value
}

async function persistIfNeeded(session, cwd) {
  if ((await backend.catalog.list({ cwd })).some(row => row.id === session.id)) return
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Seed turn timed out')), 60000)
    session.subscribe(events => {
      const end = events.find(event => event.type === 'turn.end')
      if (!end) return
      clearTimeout(timer)
      resolve(end.reason.kind)
    })
  })
  const [result, reason] = await Promise.all([
    session.submit({ text: 'Reply OK only. Do not use tools.', clientMessageId: 'benchmark-seed' }), ended,
  ])
  assert.ok(result.accepted)
  assert.equal(reason, 'completed')
}

const source = join(homedir(), '.gemini/antigravity-cli/antigravity-oauth-token')
const root = await mkdtemp(join(tmpdir(), 'agy-bench-'))
const cwd = join(root, 'workspace')
try {
  process.env.HOME = join(root, 'home')
  const state = join(process.env.HOME, '.gemini/antigravity-cli')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await copyFile(source, join(state, 'antigravity-oauth-token'))
  await mkdir(cwd)
  let id
  for (let i = 0; i < 3; i++) {
    const session = await timed('backend.create', () => backend.open({ kind: 'create', cwd }, { cwd }))
    try {
      assert.ok(!session.needsLogin, 'Expected a working agy login')
      if (i === 0) {
        id = session.id
        await persistIfNeeded(session, cwd)
      }
    } finally { await timed('backend.dispose', () => session.dispose()) }
    const rows = await timed('backend.list', () => backend.catalog.list({ cwd }))
    assert.ok(rows.some(row => row.id === id))
    const resumed = await timed('backend.resume', () => backend.open({ kind: 'resume', sessionId: id }, { cwd }))
    try { assert.equal(resumed.ref.sessionId, id) } finally { await resumed.dispose() }
    const rpc = await timed('native.initialize', () => connect(cwd))
    try {
      const request = (method, params) => rpc.request(method, params, { signal: AbortSignal.timeout(30000) })
      await timed('native.list', () => request('session/list', { cwd }))
      await timed('native.load', () => request('session/load', { sessionId: id, cwd, mcpServers: [] }))
      await timed('native.new', () => request('session/new', { cwd, mcpServers: [] }))
    } finally { await timed('native.close', () => rpc.close()) }
  }
} finally { await rm(root, { recursive: true, force: true }) }

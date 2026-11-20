// Opt-in: uses an authenticated local agy and two real model turns.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { backend } from '../backend.js'
import { executable } from '../connection.js'

const cwd = await mkdtemp(join(tmpdir(), 'antigravity-smoke-'))
const word = randomUUID().slice(0, 8)
let session
try {
  session = await backend.open({ kind: 'create', cwd }, {})
  const { sessionId } = session.ref
  let finish
  const ended = new Promise(resolve => { finish = resolve })
  session.subscribe(events => {
    for (const e of events) if (e.type === 'turn.end') finish(e)
  })
  const submitted = await session.submit({ text: 'Remember ' + word + '. Reply OK. Do not use tools.', clientMessageId: 'first' })
  assert.ok(submitted.accepted)
  const timer = setTimeout(() => void session.dispose(), 60000)
  try { assert.equal((await ended).reason.kind, 'completed') }
  finally { clearTimeout(timer) }
  await session.dispose()
  session = undefined

  const rows = await backend.catalog.list({ cwd })
  assert.ok(rows.some(s => s.id === sessionId))
  assert.ok(rows.every(s => s.cwd === cwd))
  const { stdout } = await promisify(execFile)(executable(), ['--conversation', sessionId, '-p',
    'Reply only with the code I asked you to remember. Do not use tools.', '--print-timeout', '60s'], { cwd, timeout: 65000 })
  assert.ok(stdout.includes(word))
  session = await backend.open({ kind: 'resume', sessionId }, {})
  assert.equal(session.cwd, cwd)
  assert.ok((await session.history()).some(e => e.type === 'assistant.message' && e.blocks.some(b => b.type === 'text' && b.text.includes(word))))
  console.log('PASS: ACP turn, scoped catalog, native CLI continuation, original workspace and ACP history replay')
} finally {
  await session?.dispose()
  await rm(cwd, { recursive: true, force: true })
}

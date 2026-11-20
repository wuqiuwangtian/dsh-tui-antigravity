import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { backend } from '../backend.js'

function observe(session, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Missing ' + type)) }, 4000)
    const unsubscribe = session.subscribe(events => {
      const found = events.find(e => e.type === type)
      if (found) { unsubscribe(); clearTimeout(timer); resolve(found) }
    })
  })
}
async function start(t) {
  process.env.ANTIGRAVITY_EXECUTABLE = fileURLToPath(new URL('./agent.mjs', import.meta.url))
  const s = await backend.open({ kind: 'create', cwd: process.cwd() }, {})
  t.after(() => s.dispose())
  return s
}
for (const [decision, expected] of [['reject', 'no'], ['allow-once', 'yes']]) {
  test('round-trip ' + decision + ' and keep conversation usable', async t => {
    const s = await start(t)
    const permission = observe(s, 'permission.request')
    await s.submit({ text: 'edit', clientMessageId: '1' })
    const { request } = await permission
    const end = observe(s, 'turn.end')
    s.capabilities.permissions.respond(request.requestId, { kind: decision })
    assert.equal((await end).reason.kind, 'completed')
    assert.equal((await s.history()).find(e => e.type === 'assistant.message').blocks[0].text, expected)
    const next = observe(s, 'turn.end')
    await s.submit({ text: 'hello', clientMessageId: '2' })
    assert.equal((await next).turn, 2)
  })
}
test('interrupt retracts queued inputs and settles the active turn', async t => {
  const s = await start(t)
  await s.submit({ text: 'wait', clientMessageId: '1' })
  await s.submit({ text: 'queued', clientMessageId: '2' }, 'followup')
  assert.deepEqual(await s.cancel('interrupt'), { outcome: 'confirmed', stillQueued: [] })
  assert.equal(s.status, 'idle')
  assert.equal((await s.history()).filter(e => e.type === 'user.message').length, 1)
})
test('unexpected process exit settles pending turn', async t => {
  const s = await start(t)
  const end = observe(s, 'turn.end')
  await s.submit({ text: 'exit', clientMessageId: '1' })
  assert.equal((await end).reason.kind, 'error')
})

test('ordinary cancellation preserves a queued follow-up exactly once', async t => {
  const s = await start(t)
  await s.submit({ text: 'wait', clientMessageId: 'a' })
  await s.submit({ text: 'later', clientMessageId: 'b' }, 'followup')
  let finish
  const second = new Promise(resolve => { finish = resolve })
  s.subscribe(events => { if (events.some(e => e.type === 'turn.end' && e.turn === 2)) finish() })
  assert.equal((await s.cancel('user')).outcome, 'confirmed')
  await second
  assert.deepEqual((await s.history()).filter(e => e.type === 'user.message').map(e => e.id), ['a', 'b'])
})

test('dispose settles an outstanding permission and closes the process', async t => {
  const s = await start(t)
  const asking = observe(s, 'permission.request')
  await s.submit({ text: 'edit', clientMessageId: '1' })
  await asking
  await s.dispose()
  assert.equal(s.status, 'disposed')
  assert.deepEqual(s.capabilities.permissions.pending(), [])
  assert.equal((await s.submit({ text: 'late', clientMessageId: '2' })).accepted, false)
})

test('scope listings locally and reject an unknown resume before session/load', async t => {
  await start(t)
  const cwd = process.cwd()
  const rows = await backend.catalog.list({ cwd })
  assert.deepEqual(rows.map(s => s.id), ['fixture-session'])
  await assert.rejects(backend.open({ kind: 'resume', sessionId: 'absent', cwd }, {}), /native Antigravity catalog/)
})

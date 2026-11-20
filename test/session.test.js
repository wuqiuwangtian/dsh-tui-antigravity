import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { backend } from '../backend.js'

function observe(session, type, match = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Missing ' + type)) }, 4000)
    const unsubscribe = session.subscribe(events => {
      const found = events.find(e => e.type === type && match(e))
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

test('quota uses a native command result and refreshes without opening a model turn', async t => {
  const s = await start(t)
  const isResult = e => e.request.questions[0].options.some(o => o.label === '刷新')
  const first = observe(s, 'question.request', isResult)
  await s.submit({ text: '/usage', clientMessageId: 'usage' })
  const { request } = await first
  assert.match(request.questions[0].detail, /75%/)
  const refreshed = observe(s, 'question.request', isResult)
  s.capabilities.questions.respond(request.requestId, { answers: [{ selected: ['刷新'] }] })
  s.capabilities.questions.cancel((await refreshed).request.requestId)
  assert.ok(!(await s.history()).some(e => e.type === 'turn.start'))
})

test('first login uses a secret host field and cancellation leaves the existing credential untouched', async t => {
  process.env.AGY_FIXTURE_SIGNIN = '1'
  t.after(() => { delete process.env.AGY_FIXTURE_SIGNIN })
  const s = await start(t)
  assert.ok(s.needsLogin)
  const prompt = observe(s, 'question.request')
  const signedIn = s.capabilities.auth.login()
  const {request} = await prompt
  assert.equal(request.questions[0].secret, true)
  s.capabilities.questions.cancel(request.requestId)
  await signedIn
  assert.equal(s.status, 'idle')
  assert.ok(!(await s.history()).some(e => e.type === 'question.request'))
})

test('login replaces the ACP connection only after native authorization and original session lookup', async t => {
  const s = await start(t)
  const previous = s.rpc
  const prompt = observe(s, 'question.request')
  const signedIn = s.capabilities.auth.login()
  const {request} = await prompt
  s.capabilities.questions.respond(request.requestId, { answers: [{ custom: 'fixture-code', selected: [] }] })
  await signedIn
  assert.notEqual(s.rpc, previous)
  assert.equal(s.status, 'idle')
  assert.ok(!JSON.stringify(await s.history()).includes('fixture-code'))
})

test('ACP elicitation maps displayed choices back to native values', async t => {
  const s = await start(t)
  const prompt = observe(s, 'question.request')
  const result = s.elicit({ mode: 'form', sessionId: s.id, message: 'Pick', requestedSchema: {
    properties: { language: { type: 'string', oneOf: [{ title: 'English', const: 'en' }] } }
  } })
  s.capabilities.questions.respond((await prompt).request.requestId, { answers: [{ selected: ['English'] }] })
  assert.equal((await result).content.language, 'en')
})

test('dismissal during a quota refresh closes the query without reopening a result dialog', async t => {
  const s = await start(t)
  const requests = []
  s.subscribe(events => {
    for (const e of events) if (e.type === 'question.request') {
      requests.push(e.request)
      s.capabilities.questions.cancel(e.request.requestId)
    }
  })
  await s.submit({ text: '/quota', clientMessageId: 'wait' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests.length, 1)
  assert.ok(!s.localAction)
})

test('replay combines text and images from one user message and restores attachment bytes', async t => {
  const s = await start(t)
  s.status = 'starting'
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  s.update({ sessionUpdate: 'user_message_chunk', messageId: 'one', content: { type: 'text', text: 'Look' } })
  s.update({ sessionUpdate: 'user_message_chunk', messageId: 'one', content: { type: 'image', mimeType: 'image/png', data } })
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } })
  const rows = (await s.history()).filter(e => e.type === 'user.message')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'one')
  assert.equal(rows[0].images[0].width, 1)
  assert.equal((await rows[0].images[0].read()).toString('base64'), data)
})

test('a native browser callback completes the sign-in while the code field is still open', async t => {
  process.env.AGY_FIXTURE_CALLBACK = '1'
  t.after(() => { delete process.env.AGY_FIXTURE_CALLBACK })
  const s = await start(t)
  const previous = s.rpc
  await s.capabilities.auth.login()
  assert.notEqual(s.rpc, previous)
  assert.equal(s.panels.pending.size, 0)
})

test('local account and quota commands cannot become queued messages or model steering', async t => {
  const s = await start(t)
  assert.ok((await s.submit({ text: 'wait', clientMessageId: 'turn' })).accepted)
  for (const text of ['/usage', '/agy account', '/agy folders', '/codesearch needle', '/signin']) {
    assert.equal((await s.submit({ text, clientMessageId: 'panel' }, 'followup')).accepted, false)
  }
  assert.equal(s.queue.length, 0)
  await s.cancel('user')
})

test('a timer wake delivers its streamed reply and approval after the foreground prompt ends', async t => {
  const s = await start(t)
  await s.submit({ text: 'ready', clientMessageId: 'arm' })
  await s.active
  const turn = s.turn
  const request = observe(s, 'permission.request')
  const outcome = s.permission({ sessionId: s.id, toolCall: { toolCallId: 'wake-edit' },
    options: [{ optionId: 'no', kind: 'reject_once', name: 'Deny' }] })
  s.capabilities.permissions.respond((await request).request.requestId, { kind: 'reject' })
  assert.equal((await outcome).outcome.optionId, 'no')
  assert.equal(s.status, 'idle')
  for (const text of ['PINK ', 'ORANGE']) {
    s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  s.update({ sessionUpdate: 'usage_update', used: 5, size: 120 })
  const events = await s.history()
  assert.equal(s.turn, turn)
  assert.equal(events.filter(e => e.type === 'user.message').length, 1)
  assert.equal(events.filter(e => e.type === 'assistant.message').at(-1).blocks[0].text, 'PINK ORANGE')
  assert.ok((await s.submit({ text: 'next', clientMessageId: 'next' })).accepted)
  await s.active
})

test('partial task updates retain their result, native task status and image until completion', async t => {
  const s = await start(t)
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  s.update({ sessionUpdate: 'tool_call', toolCallId: 'timer', name: 'schedule', status: 'in_progress', rawInput: { Prompt: 'read a file' } })
  assert.match((await s.report('tasks')).text, /计时器 · 运行中 · read a file/)
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'timer', content: [
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
    { type: 'diff', path: 'timer.txt', oldText: '', newText: 'fired' },
  ] })
  const end = { sessionUpdate: 'tool_call_update', toolCallId: 'timer', status: 'completed' }
  s.update(end)
  s.update(end)
  const events = await s.history()
  const result = events.find(e => e.type === 'tool.result')
  assert.equal((await result.images[0].read()).toString('base64'), data)
  assert.equal(result.presentation.diffs[0].newText, 'fired')
  assert.equal(events.filter(e => e.type === 'task.end').length, 1)
  assert.match((await s.report('tasks')).text, /计时器 · 已完成/)
})

test('native artifact references and embedded resources survive transcript projection', async t => {
  const s = await start(t)
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'Plan', uri: 'file:///test/plan.md' } })
  s.update({ sessionUpdate: 'usage_update', used: 1, size: 100 })
  s.update({ sessionUpdate: 'tool_call', toolCallId: 'attachment', status: 'completed',
    content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'example:notes', text: 'notes' } } }] })
  const events = await s.history()
  assert.equal(events.find(e => e.type === 'assistant.message').blocks[0].text, 'Plan · file:///test/plan.md')
  assert.equal(events.find(e => e.type === 'tool.result').text, 'example:notes\nnotes')
})

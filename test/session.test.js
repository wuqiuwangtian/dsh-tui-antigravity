import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  const previousBrowser = process.env.BROWSER
  process.env.BROWSER = 'true'
  t.after(() => {
    if (previousBrowser === undefined) delete process.env.BROWSER
    else process.env.BROWSER = previousBrowser
  })
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

test('resume verifies the ID and loads on the same workspace process, stopping at the matching page', async t => {
  await start(t)
  const workspace = await mkdtemp(join(tmpdir(), 'resume-workspace-'))
  const log = join(workspace, 'rpc-log')
  t.after(async () => {
    delete process.env.AGY_FIXTURE_RPC_LOG
    delete process.env.AGY_FIXTURE_WORKSPACE
    await rm(workspace, { recursive: true, force: true })
  })
  process.env.AGY_FIXTURE_RPC_LOG = log
  process.env.AGY_FIXTURE_WORKSPACE = workspace
  for (const from of [workspace, process.cwd()]) {
    await writeFile(log, '')
    const session = await backend.open({ kind: 'resume', sessionId: 'fixture-session' }, { cwd: from })
    try {
      assert.equal(session.cwd, workspace)
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(calls.filter(c => c.cwd === workspace).map(c => c.method), ['initialize', 'session/list', 'session/load'])
      assert.equal(new Set(calls.filter(c => c.cwd === workspace).map(c => c.pid)).size, 1)
      if (from !== workspace) assert.deepEqual(calls.filter(c => c.cwd === from).map(c => c.method), ['initialize', 'session/list'])
    } finally { await session.dispose() }
  }
})

test('quota reports use transcript rows, share the cache across aliases, and support forced refresh', async t => {
  const s = await start(t)
  const home = await mkdtemp(join(tmpdir(), 'quota-test-'))
  const previous = process.env.HOME
  process.env.HOME = home
  t.after(async () => { process.env.HOME = previous; await rm(home, { recursive: true, force: true }) })
  const dir = join(home, '.gemini', 'antigravity-cli')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'antigravity-oauth-token'), 'fixture marker')
  const report = s.report.bind(s)
  let calls = 0
  s.report = (...args) => { calls++; return report(...args) }
  async function query(text) {
    const next = observe(s, 'user.message', e => e.source === 'command-output')
    await s.submit({ text, clientMessageId: text })
    const row = await next
    assert.ok(row.displayLive)
    assert.match(row.text, /75%/)
    return row
  }
  assert.equal((await query('/usage')).label, '/usage')
  assert.match((await query('/agy quota')).text, /缓存/)
  assert.equal(calls, 1)
  await query('/usage refresh')
  assert.equal(calls, 2)
  await writeFile(join(dir, 'antigravity-oauth-token'), 'changed identity')
  await query('/quota')
  assert.equal(calls, 3)
  assert.equal(s.panels.pending.size, 0)
  assert.ok(!(await s.history()).some(e => e.type === 'turn.start'))
})

test('task-bearing plan commands preserve the native prompt and block boundaries', async t => {
  const s = await start(t)
  const prompts = []
  const request = s.rpc.request.bind(s.rpc)
  s.rpc.request = (method, params) => {
    if (method === 'session/prompt') prompts.push(params.prompt)
    return request(method, params)
  }
  s.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan', description: 'plan' }] })
  s.capabilities.modes = {}
  for (const prefix of ['/plan /grill-me ', '/agy plan /grill-me ', '/grill-me /plan ']) {
    await s.submit({ clientMessageId: prefix, text: prefix + 'test', blocks: [{ type: 'text', text: prefix }, { type: 'text', text: 'test' }] })
    await s.active
    assert.deepEqual(prompts.at(-1).map(b => b.text), [prefix.replace('/agy ', '/'), 'test'])
  }
})

test('every advertised native command is reachable via the agy namespace', async t => {
  const s = await start(t)
  const native = ['agy-customizations','antigravity-guide','browser','compact','goal','grill-me','learn','plan','run-workflow','schedule','swarm','workspace-skill']
  s.update({ sessionUpdate: 'available_commands_update', availableCommands: native.map(name => ({ name, description: name })) })
  const prompts = []
  const request = s.rpc.request.bind(s.rpc)
  s.rpc.request = (method, params) => {
    if (method === 'session/prompt') prompts.push(params.prompt[0].text)
    return request(method, params)
  }
  for (const name of native) {
    assert.ok((await s.submit({ text: '/agy ' + name + ' task', clientMessageId: name })).accepted)
    await s.active
  }
  assert.deepEqual(prompts, native.map(name => '/' + name + ' task'))
  assert.equal((await s.submit({text: '/agy unadvertised task', clientMessageId: 'unknown'})).accepted, false)
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

test('native interview choices and write-ins share one question and preserve ACP field names', async t => {
  const s = await start(t)
  for (const [answer, expected] of [
    [{ selected: ['Recommended'] }, { q1: '1' }],
    [{ selected: [], custom: 'Guests' }, { q1_other: 'Guests' }],
  ]) {
    const question = observe(s, 'question.request')
    const result = s.elicit({ mode: 'form', sessionId: s.id, message: 'The agent has a question.', requestedSchema: {
      properties: { q1: { type: 'string', title: 'Audience?', oneOf: [{ const: '1', title: 'Recommended' }] },
        q1_other: { type: 'string', title: 'Other' } },
    } }, new AbortController().signal)
    const { request } = await question
    assert.equal(request.questions.length, 1)
    assert.equal(request.questions[0].question, 'Audience?')
    assert.equal(request.questions[0].hideCustomInput, false)
    s.capabilities.questions.respond(request.requestId, { answers: [answer] })
    const response = await result
    assert.equal(response.action, 'accept')
    assert.deepEqual({ ...response.content }, expected)
  }
})

test('duplicate lookups share one query and disposal suppresses a late report', async t => {
  const s = await start(t)
  let release, started
  const pending = new Promise(resolve => { started = resolve })
  let calls = 0
  s.report = () => { calls++; started(); return new Promise(resolve => { release = resolve }) }
  await s.submit({ text: '/usage', clientMessageId: 'first' })
  await pending
  await s.submit({ text: '/quota refresh', clientMessageId: 'second' })
  assert.equal(calls, 1)
  assert.equal(s.localAction, undefined)
  await s.dispose()
  release({ text: 'late result' })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!(await s.history()).some(e => e.source === 'command-output'))
})

test('long reports can be paged without another query or question dialog', async t => {
  const s = await start(t)
  let calls = 0
  s.report = async () => { calls++; return { text: Array.from({length: 32}, (_, i) => 'line-' + i).join('\n') } }
  const first = observe(s, 'user.message')
  await s.submit({ text: '/changelog', clientMessageId: 'one' })
  assert.match((await first).text, /1\/2 页/)
  const second = observe(s, 'user.message')
  await s.submit({ text: '/agy changelog page 2', clientMessageId: 'two' })
  assert.match((await second).text, /line-31/)
  assert.equal(calls, 1)
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

test('authorized account without the old conversation retires the old process and directs the user to /new', async t => {
  const s = await start(t)
  const previous = s.rpc
  process.env.AGY_FIXTURE_EMPTY_CATALOG = '1'
  t.after(() => { delete process.env.AGY_FIXTURE_EMPTY_CATALOG })
  const prompt = observe(s, 'question.request')
  const signingIn = s.capabilities.auth.login()
  s.capabilities.questions.respond((await prompt).request.requestId, { answers: [{ selected: [], custom: 'fixture-code' }] })
  await signingIn
  await previous.closed
  assert.equal(s.rpc, undefined)
  assert.equal(s.status, 'idle')
  assert.match((await s.report('account')).text, /授权已完成.*\/new/)
  assert.equal((await s.submit({ text: '/plan', clientMessageId: 'mode' })).accepted, false)
  assert.match((await s.submit({ text: 'hello', clientMessageId: 'work' })).reason, /\/new/)
  await assert.rejects(s.reconnect([], false), /\/new/)
})

test('successful first login keeps the placeholder and gives the host new-session instructions', async t => {
  process.env.AGY_FIXTURE_SIGNIN = '1'
  t.after(() => { delete process.env.AGY_FIXTURE_SIGNIN })
  const s = await start(t)
  const prompt = observe(s, 'question.request')
  const signingIn = s.capabilities.auth.login()
  s.capabilities.questions.respond((await prompt).request.requestId, { answers: [{ selected: [], custom: 'fixture-code' }] })
  await signingIn
  assert.match((await s.capabilities.auth.status()).lines[0], /已登录.*\/new/)
  assert.match((await s.submit({ text: 'hello', clientMessageId: 'early' })).reason, /已登录.*\/new/)
})

test('a failed native callback closes the code field, reports failure and leaves the original connection usable', async t => {
  process.env.AGY_FIXTURE_CALLBACK = 'failed'
  t.after(() => { delete process.env.AGY_FIXTURE_CALLBACK })
  const s = await start(t)
  const previous = s.rpc
  const notice = observe(s, 'notice', e => e.level === 'error')
  await s.capabilities.auth.login()
  assert.match((await notice).text, /重新运行 \/login/)
  assert.equal(s.rpc, previous)
  assert.equal(s.panels.pending.size, 0)
  assert.ok((await s.submit({ text: 'hello', clientMessageId: 'same' })).accepted)
  await s.active
})

test('percent-encoded non-ASCII workspaces decode in catalog listings and resume without ENOENT', async t => {
  await start(t)
  const root = await mkdtemp(join(tmpdir(), 'agy-cjk-'))
  const chineseDir = join(root, '计算机安全paper02')
  await mkdir(chineseDir, { recursive: true })
  t.after(async () => {
    delete process.env.AGY_FIXTURE_WORKSPACE
    delete process.env.AGY_FIXTURE_STRICT_LIST
    await rm(root, { recursive: true, force: true })
  })
  process.env.AGY_FIXTURE_WORKSPACE = encodeURI(chineseDir)
  process.env.AGY_FIXTURE_STRICT_LIST = '1'
  const all = await backend.catalog.list({ allProjects: true })
  assert.equal(all[0].cwd, chineseDir)
  const scoped = await backend.catalog.list({ cwd: chineseDir })
  assert.deepEqual(scoped.map(s => [s.id, s.cwd]), [['fixture-session', chineseDir]])
  const resumed = await backend.open({ kind: 'resume', sessionId: 'fixture-session' }, { cwd: process.cwd() })
  t.after(() => resumed.dispose())
  assert.equal(resumed.cwd, chineseDir)
  assert.equal(resumed.status, 'idle')
})

test('host paths stay literal and agy catalog paths are decoded only once', async t => {
  await start(t)
  const root = await mkdtemp(join(tmpdir(), 'agy-percent-'))
  const dirs = [join(root, 'team docs'), join(root, 'team%20docs')]
  t.after(async () => {
    delete process.env.AGY_FIXTURE_WORKSPACE
    await rm(root, { recursive: true, force: true })
  })
  for (const cwd of dirs) await mkdir(cwd)
  for (const cwd of dirs) {
    process.env.AGY_FIXTURE_WORKSPACE = encodeURI(cwd)
    const rows = await backend.catalog.list({ cwd })
    assert.deepEqual(rows.map(row => row.cwd), [cwd])
    assert.deepEqual(await backend.catalog.list({ cwd: dirs.find(dir => dir !== cwd) }), [])
    for (const target of [{ kind: 'create', cwd }, { kind: 'resume', sessionId: 'fixture-session', cwd }]) {
      const session = await backend.open(target, { cwd: root })
      try { assert.equal(session.cwd, cwd) } finally { await session.dispose() }
    }
  }
})

test('a missing workspace requires confirmation before loading history or running tools', async t => {
  await start(t)
  const dir = await mkdtemp(join(tmpdir(), 'agy-relocate-'))
  const missing = join(dir, 'old')
  const log = join(dir, 'rpc')
  process.env.AGY_FIXTURE_WORKSPACE = missing
  process.env.AGY_FIXTURE_RPC_LOG = log
  t.after(async () => {
    delete process.env.AGY_FIXTURE_WORKSPACE
    delete process.env.AGY_FIXTURE_RPC_LOG
    await rm(dir, { recursive: true, force: true })
  })
  const s = await backend.open({ kind: 'resume', sessionId: 'fixture-session' }, { cwd: process.cwd() })
  t.after(() => s.dispose())
  const answer = (event, a) => s.capabilities.questions.respond(event.request.requestId, { answers: [a] })
  const first = await observe(s, 'question.request')
  assert.ok(first.request.questions[0].detail.includes(missing))
  const cancelled = observe(s, 'notice')
  answer(first, { selected: ['取消'] })
  await cancelled
  assert.equal((await s.submit({ text: 'write something' })).accepted, false)
  assert.doesNotMatch(await readFile(log, 'utf8'), /session\/(load|prompt)/)
  const retry = observe(s, 'question.request')
  await s.submit({ text: '/workspace' })
  const input = observe(s, 'question.request')
  answer(await retry, { selected: ['输入其他目录'] })
  const confirm = observe(s, 'question.request', e => e.request.questions[0].question.includes('运行工具'))
  answer(await input, { custom: dir })
  const last = await confirm
  assert.equal(last.request.questions[0].detail, dir)
  const ready = observe(s, 'session.ready')
  answer(last, { selected: ['确认恢复'] })
  await ready
  assert.equal(s.cwd, dir)
  assert.ok((await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).some(c => c.cwd === dir && c.method === 'session/load'))
})

test('model, reasoning effort, and permission mode persist across restarts without persisting temporary plan mode', async t => {
  await start(t)
  const dataDir = await mkdtemp(join(tmpdir(), 'agy-prefs-'))
  const fixtureConfig = [
    { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'claude-sonnet', name: 'Claude Sonnet' }] },
    { id: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }, { value: 'medium', name: 'Medium' }] },
    { id: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'yolo', name: 'Yolo' }, { value: 'plan', name: 'Plan' }] },
  ]
  process.env.AGY_FIXTURE_CONFIG = JSON.stringify(fixtureConfig)
  t.after(async () => {
    delete process.env.AGY_FIXTURE_CONFIG
    await rm(dataDir, { recursive: true, force: true })
  })
  const host = { cwd: process.cwd(), dataDir }
  const first = await backend.open({ kind: 'create', cwd: process.cwd() }, host)
  try {
    assert.equal(first.capabilities.models.current().model, 'gemini-4-neon')
    assert.equal(first.capabilities.effort.current(), 'high')
    assert.equal(first.capabilities.modes.current(), 'default')
    await first.capabilities.models.set({ model: 'claude-sonnet' })
    await first.capabilities.effort.set('medium')
    await first.capabilities.modes.set('yolo')
    // Temporary plan mode must not overwrite the saved permission mode, and /plan off restores yolo.
    await first.capabilities.modes.set('plan')
    assert.deepEqual(first.capabilities.modes.cycle().map(o => o.id), ['yolo', 'plan'])
    await first.submit({ text: '/plan off', clientMessageId: 'plan-off' })
    assert.equal(first.capabilities.modes.current(), 'yolo')
    await first.capabilities.modes.set('plan')
  } finally { await first.dispose() }

  // Restart with a fresh create session and a resumed session: both restore claude-sonnet / medium / yolo.
  for (const target of [{ kind: 'create', cwd: process.cwd() }, { kind: 'resume', sessionId: 'fixture-session', cwd: process.cwd() }]) {
    const reopened = await backend.open(target, host)
    try {
      assert.equal(reopened.capabilities.models.current().model, 'claude-sonnet')
      assert.equal(reopened.capabilities.effort.current(), 'medium')
      assert.equal(reopened.capabilities.modes.current(), 'yolo')
      const ready = (await reopened.history()).find(e => e.type === 'session.ready')
      assert.equal(ready.model, 'claude-sonnet')
      assert.equal(ready.effort, 'medium')
      assert.equal(ready.permissionMode, 'yolo')
    } finally { await reopened.dispose() }
  }

  // Unavailable saved options are ignored gracefully without failing open.
  await writeFile(join(dataDir, 'prefs.json'), JSON.stringify({ model: 'removed-model', effort: 'removed', mode: 'removed' }))
  const fallback = await backend.open({ kind: 'create', cwd: process.cwd() }, host)
  try {
    assert.equal(fallback.capabilities.models.current().model, 'gemini-4-neon')
    assert.equal(fallback.capabilities.effort.current(), 'high')
    assert.equal(fallback.capabilities.modes.current(), 'default')
  } finally { await fallback.dispose() }

  // Legacy last-session file is still readable and cleared on forget().
  await rm(join(dataDir, 'prefs.json'), { force: true })
  await writeFile(join(dataDir, 'last-session'), 'legacy-id\n')
  const sessionPrefs = backend.launch.sessionPrefs(host)
  assert.equal(sessionPrefs.lastSession(), 'legacy-id')
  sessionPrefs.forget('legacy-id')
  assert.equal(sessionPrefs.lastSession(), undefined)
})

test('tool call and result presentations use short names and structured cards without giant blank headers', async t => {
  const s = await start(t)
  const longCmd = 'node -e "const fs = require(\'node:fs\'); console.log(' + 'x'.repeat(180) + ')"\nsecond line'
  s.update({ sessionUpdate: 'tool_call', toolCallId: 'exec-1', kind: 'execute', title: longCmd, rawInput: { CommandLine: longCmd }, status: 'in_progress' })
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done output' } }] })

  const insideFile = join(process.cwd(), 'session.js')
  s.update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', name: 'read_file', title: 'File ' + insideFile, rawInput: { Path: insideFile }, status: 'in_progress' })
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line1\nline2' } }] })

  s.update({ sessionUpdate: 'tool_call', toolCallId: 'fail-1', kind: 'other', name: 'custom_tool', title: 'Run custom', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] })

  const events = await s.history()
  const execCall = events.find(e => e.type === 'tool.call' && e.callId === 'exec-1')
  const execResult = events.find(e => e.type === 'tool.result' && e.callId === 'exec-1')
  assert.equal(execCall.name, 'bash')
  assert.equal(execCall.presentation.card, 'terminal')
  assert.equal(execCall.presentation.displayKey, 'tool-name-bash')
  assert.ok(!execCall.presentation.title.includes('\n'))
  assert.equal(execResult.presentation.card, 'terminal')
  assert.equal(execResult.presentation.output, 'done output')
  assert.equal(execResult.presentation.title, undefined)

  const readCall = events.find(e => e.type === 'tool.call' && e.callId === 'read-1')
  const readResult = events.find(e => e.type === 'tool.result' && e.callId === 'read-1')
  assert.equal(readCall.name, 'read')
  assert.equal(readCall.presentation.card, 'generic')
  assert.equal(readCall.presentation.title, 'Read session.js')
  assert.equal(readResult.presentation.card, 'read')
  assert.equal(readResult.presentation.path, insideFile)

  const failResult = events.find(e => e.type === 'tool.result' && e.callId === 'fail-1')
  assert.equal(failResult.isError, true)
  assert.equal(failResult.errorText, 'boom')
})

test('steer stays pending until confirmed and Esc interrupt does not deadlock on a hung steer RPC', async t => {
  const s = await start(t)
  const pendingEvents = []
  s.subscribe(events => {
    for (const e of events) if (e.type === 'pending.changed') pendingEvents.push(e)
  })
  await s.submit({ text: 'wait', clientMessageId: 'turn-1' })
  await s.submit({ text: 'steer-hang', clientMessageId: 'steer-1' }, 'steer')
  // Steer must remain visible in pending (not prematurely claimed) so the UI shows a queued indicator.
  assert.ok(pendingEvents.some(e => e.items?.some(i => i.id === 'steer-1' && i.placement === 'steer')))
  assert.ok(!pendingEvents.some(e => e.claimed?.includes('steer-1')))
  assert.equal((await s.history()).filter(e => e.type === 'user.message').length, 1)

  // Esc with pending message sends cancel('interrupt'): discards backend copy cleanly without hanging.
  const receipt = await s.cancel('interrupt')
  assert.deepEqual(receipt, { outcome: 'confirmed', stillQueued: [] })
  assert.equal(s.status, 'idle')
  assert.ok(pendingEvents.some(e => e.discarded?.includes('steer-1')))
})

test('user cancel preserves an unclaimed steer as the next turn, and a failed steer falls back to the queue', async t => {
  const s = await start(t)
  await s.submit({ text: 'wait', clientMessageId: 't1' })
  const notice = observe(s, 'notice', e => e.level === 'info')
  await s.submit({ text: 'steer-fail', clientMessageId: 's-fail' }, 'steer')
  await notice
  const secondEnd = observe(s, 'turn.end', e => e.turn === 2)
  assert.equal((await s.cancel('user')).outcome, 'confirmed')
  await secondEnd
  assert.equal(s.status, 'idle')

  // Unclaimed hung steer survives cancel('user') by moving to the next turn instead of deadlocking.
  await s.submit({ text: 'wait', clientMessageId: 't3' })
  await s.submit({ text: 'steer-hang', clientMessageId: 's-hang' }, 'steer')
  const fourthStart = observe(s, 'turn.start', e => e.turn === 4 && e.userMessageId === 's-hang')
  assert.equal((await s.cancel('user')).outcome, 'confirmed')
  await fourthStart
  await s.cancel('interrupt')

  // When a steer succeeds mid-turn, it is claimed and emitted as a user message.
  await s.submit({ text: 'wait', clientMessageId: 't5' })
  const claimed = observe(s, 'pending.changed', e => e.claimed?.includes('s-ok'))
  await s.submit({ text: 'steer-ok', clientMessageId: 's-ok' }, 'steer')
  await claimed
  assert.ok((await s.history()).some(e => e.type === 'user.message' && e.id === 's-ok'))
  assert.equal((await s.cancel('user')).outcome, 'confirmed')
})

test('full-access mode restarts agy with --dangerously-skip-permissions, persists across restarts, and stays out of Shift+Tab by default', async t => {
  await start(t)
  const dir = await mkdtemp(join(tmpdir(), 'agy-full-access-'))
  const log = join(dir, 'rpc-log')
  const fixtureConfig = [
    { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
    { id: 'mode', currentValue: 'default', options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ] },
  ]
  process.env.AGY_FIXTURE_CONFIG = JSON.stringify(fixtureConfig)
  process.env.AGY_FIXTURE_RPC_LOG = log
  t.after(async () => {
    delete process.env.AGY_FIXTURE_CONFIG
    delete process.env.AGY_FIXTURE_RPC_LOG
    await rm(dir, { recursive: true, force: true })
  })
  const host = { cwd: process.cwd(), dataDir: dir }
  const readLog = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

  // 1. Default session exposes full-access in /permission list, but Shift+Tab cycle excludes it.
  await writeFile(log, '')
  const first = await backend.open({ kind: 'create', cwd: process.cwd() }, host)
  try {
    assert.deepEqual(first.capabilities.modes.list().map(o => o.id), ['default', 'accept-edits', 'auto', 'full-access', 'plan'])
    assert.deepEqual(first.capabilities.modes.cycle().map(o => o.id), ['default', 'plan'])
    assert.equal(first.capabilities.modes.current(), 'default')
    assert.equal((await readLog()).at(-1).skipPermissions, false)

    // Cannot toggle full-access while a turn is running.
    await first.submit({ text: 'wait', clientMessageId: 'busy' })
    await assert.rejects(first.capabilities.modes.set('full-access'), /结束当前回合/)
    await first.cancel('user')

    // 2. Selecting full-access reconnects agy acp with --dangerously-skip-permissions on the same session ID.
    await writeFile(log, '')
    await first.capabilities.modes.set('full-access')
    assert.equal(first.capabilities.modes.current(), 'full-access')
    assert.deepEqual(first.capabilities.modes.cycle().map(o => o.id), ['full-access', 'plan'])
    assert.ok(first.capabilities.diagnostics.lines().some(l => l.includes('--dangerously-skip-permissions')))
    const enterCalls = await readLog()
    assert.ok(enterCalls.some(c => c.method === 'session/load' && c.skipPermissions === true))

    // 3. Entering and leaving /plan from full-access stays on the same process without respawning.
    await writeFile(log, '')
    await first.capabilities.modes.set('plan')
    assert.equal(first.capabilities.modes.current(), 'plan')
    await first.submit({ text: '/plan off', clientMessageId: 'plan-off' })
    assert.equal(first.capabilities.modes.current(), 'full-access')
    const planCalls = await readLog()
    assert.ok(!planCalls.some(c => c.method === 'initialize'))
  } finally { await first.dispose() }

  // 4. Restarting with persisted full-access launches directly with --dangerously-skip-permissions.
  await writeFile(log, '')
  const restarted = await backend.open({ kind: 'create', cwd: process.cwd() }, host)
  try {
    assert.equal(restarted.capabilities.modes.current(), 'full-access')
    const ready = (await restarted.history()).find(e => e.type === 'session.ready')
    assert.equal(ready.permissionMode, 'full-access')
    const bootCalls = await readLog()
    assert.equal(new Set(bootCalls.map(c => c.pid)).size, 1)
    assert.ok(bootCalls.every(c => c.skipPermissions === true))

    // 5. Leaving full-access for auto reconnects WITHOUT --dangerously-skip-permissions and updates prefs.
    await writeFile(log, '')
    await restarted.capabilities.modes.set('auto')
    assert.equal(restarted.capabilities.modes.current(), 'auto')
    const exitCalls = await readLog()
    assert.ok(exitCalls.some(c => c.method === 'session/load' && c.skipPermissions === false))
    assert.ok(exitCalls.some(c => c.method === 'session/set_config_option' && c.configId === 'mode' && c.value === 'auto'))
  } finally { await restarted.dispose() }
})

test('assistant Markdown image embeds and image read_file results attach local TranscriptImage facades within session roots only', async t => {
  const previousHome = process.env.HOME
  const sandbox = await mkdtemp(join(tmpdir(), 'agy-images-'))
  const fakeHome = join(sandbox, 'home')
  const workspace = join(sandbox, 'workspace')
  const outside = join(sandbox, 'outside')
  const brainDir = join(fakeHome, '.gemini', 'antigravity-cli', 'brain', 'fixture-session', 'scratch')
  const otherBrainDir = join(fakeHome, '.gemini', 'antigravity-cli', 'brain', 'other-session')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(brainDir, { recursive: true }),
    mkdir(otherBrainDir, { recursive: true }),
  ])
  process.env.HOME = fakeHome
  process.env.ANTIGRAVITY_EXECUTABLE = fileURLToPath(new URL('./agent.mjs', import.meta.url))
  t.after(async () => {
    process.env.HOME = previousHome
    await rm(sandbox, { recursive: true, force: true })
  })

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const brainPng = join(brainDir, 'style_A.png')
  const workspacePng = join(workspace, '示例图.png')
  const outsidePng = join(outside, 'secret.png')
  const otherBrainPng = join(otherBrainDir, 'foreign.png')
  const fakePng = join(workspace, 'not-an-image.png')
  const escapedLink = join(workspace, 'escape.png')
  await Promise.all([
    writeFile(brainPng, png),
    writeFile(workspacePng, png),
    writeFile(outsidePng, png),
    writeFile(otherBrainPng, png),
    writeFile(fakePng, 'plain text pretending to be png'),
  ])
  await symlink(outsidePng, escapedLink)

  const s = await backend.open({ kind: 'create', cwd: workspace }, { cwd: workspace })
  t.after(() => s.dispose())

  const reply = [
    '直接看下面风格：',
    `![风格 A：Windows Terminal](${pathToFileURL(brainPng).href})`,
    `![重复引用](${pathToFileURL(brainPng).href})`,
    '![工作区中文图](示例图.png)',
    `![外部文件](${pathToFileURL(outsidePng).href})`,
    `![其他会话](${pathToFileURL(otherBrainPng).href})`,
    '![符号链接越界](escape.png)',
    '![伪造图片](not-an-image.png)',
    '![远程图片](https://example.com/a.png)',
    '`![行内代码](示例图.png)`',
    '```md',
    `![代码块内](${pathToFileURL(brainPng).href})`,
    '```',
    `[普通链接不是内嵌图](${pathToFileURL(workspacePng).href})`,
  ].join('\n')
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
  s.flush()

  // read_file on a local image attaches a tool.result image; out-of-scope read_file does not.
  s.update({ sessionUpdate: 'tool_call', toolCallId: 'read-img', kind: 'read', name: 'read_file', title: 'File ' + brainPng, rawInput: { Path: brainPng }, status: 'in_progress' })
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-img', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Showing binary file of type image/png' } }] })

  s.update({ sessionUpdate: 'tool_call', toolCallId: 'read-outside', kind: 'read', name: 'read_file', title: 'File ' + outsidePng, rawInput: { Path: outsidePng }, status: 'in_progress' })
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-outside', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Showing binary file of type image/png' } }] })

  const events = await s.history()
  const assistant = events.find(e => e.type === 'assistant.message')
  assert.equal(assistant.images.length, 2)
  assert.equal(assistant.images[0].name, '风格 A：Windows Terminal')
  assert.equal(assistant.images[0].mediaType, 'image/png')
  assert.equal(assistant.images[0].width, 1)
  assert.equal(assistant.images[0].height, 1)
  assert.deepEqual(Buffer.from(await assistant.images[0].read()), png)
  assert.equal(assistant.images[1].name, '工作区中文图')
  assert.equal(assistant.images[1].path, workspacePng)

  const readImgResult = events.find(e => e.type === 'tool.result' && e.callId === 'read-img')
  assert.equal(readImgResult.images.length, 1)
  assert.equal(readImgResult.images[0].path, brainPng)
  assert.deepEqual(Buffer.from(await readImgResult.images[0].read()), png)

  const readOutsideResult = events.find(e => e.type === 'tool.result' && e.callId === 'read-outside')
  assert.equal(readOutsideResult.images, undefined)
})

test('local image attachments use content-hashed IDs, detected mediaType, version-checked reads, and ignore indented code examples', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'agy-image-review-'))
  process.env.ANTIGRAVITY_EXECUTABLE = fileURLToPath(new URL('./agent.mjs', import.meta.url))
  t.after(async () => { await rm(workspace, { recursive: true, force: true }) })

  // 1x1 PNG (68 bytes) and 1x1 GIF (42 bytes).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const target = join(workspace, 'preview.png')
  await writeFile(target, png)

  const s = await backend.open({ kind: 'create', cwd: workspace }, { cwd: workspace })
  t.after(() => s.dispose())

  // Four-space and tab indented Markdown examples (including right after a heading)
  // and tilde fences inside blockquotes must not attach images.
  const docsExample = [
    '# Markdown 写法示例',
    '    ![after-heading](preview.png)',
    '',
    '    ![example](preview.png)',
    '\t![tab-example](preview.png)',
    '',
    '> ~~~md',
    '> ![quoted-fence](preview.png)',
    '> ~~~',
  ].join('\n')
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: docsExample } })
  s.flush()

  // Repeated references to the same image in one message deduplicate before hashing
  // (also verify real image inside a blockquote outside a fence still renders).
  const repeated = Array.from({ length: 20 }, (_, i) => `![dup-${i}](preview.png)`).join('\n') + '\n> ![quoted-real](preview.png)'
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: repeated } })
  s.flush()
  await writeFile(target, gif)
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '![v2](preview.png)' } })
  s.flush()

  const replies = (await s.history()).filter(e => e.type === 'assistant.message')
  assert.equal(replies[0].images, undefined)
  assert.equal(replies[1].images.length, 1)
  const [v1] = replies[1].images
  const [v2] = replies[2].images
  assert.notEqual(v1.id, v2.id)
  assert.equal(v1.mediaType, 'image/png')
  assert.equal(v1.bytes, png.length)
  assert.equal(v2.mediaType, 'image/gif')
  assert.equal(v2.bytes, gif.length)
  // v1 detects that the underlying file was overwritten; v2 reads the exact current bytes.
  await assert.rejects(v1.read(), /changed since it was recorded/)
  assert.deepEqual(Buffer.from(await v2.read()), gif)

  // Replacing a parent directory with a symlink pointing outside the workspace
  // is rejected by handle verification even if the symlink target has matching bytes.
  const subDir = join(workspace, 'sub')
  const outsideDir = await mkdtemp(join(tmpdir(), 'agy-outside-dir-'))
  t.after(async () => { await rm(outsideDir, { recursive: true, force: true }) })
  await mkdir(subDir, { recursive: true })
  await writeFile(join(subDir, 'pic.png'), png)
  await writeFile(join(outsideDir, 'pic.png'), png)
  s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '![sub](sub/pic.png)' } })
  s.flush()
  const subImage = (await s.history()).filter(e => e.type === 'assistant.message').at(-1).images[0]
  await rm(subDir, { recursive: true, force: true })
  await symlink(outsideDir, subDir)
  await assert.rejects(subImage.read(), /outside session roots/)
})

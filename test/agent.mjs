#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const identities = process.env.AGY_FIXTURE_IDENTITIES
const account = identities && existsSync(identities) ? readFileSync(identities, 'utf8') : undefined
if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log('Fixture ACP 1')
  process.exit(0)
}
if (process.argv[2] === 'remote-control') {
  const args = process.argv.slice(3)
  appendFileSync(process.env.AGY_FIXTURE_REMOTE_LOG, args.join(' ') + '\n')
  if (args[0] === 'status') console.log('Daemon status: inactive')
  process.exit(0)
}
if (process.argv.includes('--login')) {
  console.log('https://accounts.google.com/o/oauth2/auth?test=1')
  if (process.env.AGY_FIXTURE_CALLBACK) setTimeout(() => process.exit(process.env.AGY_FIXTURE_CALLBACK === 'failed' ? 1 : 0), 100)
  for await (const code of createInterface({ input: process.stdin })) {
    if (identities && ['code-A', 'code-B'].includes(code)) {
      writeFileSync(identities, code.slice(-1))
      process.exit(0)
    }
    process.exit(code === 'fixture-code' ? 0 : 1)
  }
  process.exit(1)
}
if (process.argv.includes('-p')) {
  console.log(JSON.stringify({ event: 'command_result', command: { name: 'usage', data: { groups: [
    { name: 'Example', buckets: [{ name: 'Week', remaining_fraction: 0.75 }] }] } } }))
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', num_turns: 0 } }))
  process.exit(0)
}
const sessionId = account ? 'fixture-account-' + account : 'fixture-session'
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n')
const update = update => send({ method: 'session/update', params: { sessionId, update } })
let prompting
for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id, result } = JSON.parse(line)
  if (method && process.env.AGY_FIXTURE_RPC_LOG) {
    appendFileSync(process.env.AGY_FIXTURE_RPC_LOG, JSON.stringify({ pid: process.pid, method, cwd: process.cwd() }) + '\n')
  }
  switch (method) {
    case 'initialize': send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }); break
    case 'session/list':
      if (process.env.AGY_FIXTURE_WORKSPACE) {
        send({ id, result: params.cursor ? { sessions: [] } : {
          sessions: [{ sessionId, cwd: process.env.AGY_FIXTURE_WORKSPACE, title: 'catalog fixture' }], nextCursor: 'second',
        } })
        break
      }
      if (process.env.AGY_FIXTURE_EMPTY_CATALOG || (identities && !account)) { send({ id, result: { sessions: [] } }); break }
      send({ id, result: { sessions: [{ sessionId, cwd: process.cwd(), title: 'fixture' },
        { sessionId: 'foreign', cwd: '/another-project', title: 'other' }] } })
      break
    case 'session/load': send({ id, result: { sessionId } }); break
    case 'session/new':
      if (process.env.AGY_FIXTURE_SIGNIN || (identities && !account)) { send({ id, error: { code: -32000, message: 'Authentication required' } }); break }
      send({ id, result: { sessionId } }); break
    case 'session/prompt':
      prompting = id
      if (params.prompt[0].text === 'exit') process.exit(1)
      if (params.prompt[0].text === 'wait') break
      if (params.prompt[0].text === 'edit') {
        send({ id: 'permission', method: 'session/request_permission', params: { sessionId,
          toolCall: { toolCallId: 'edit', title: 'Edit file' },
          options: [{ optionId: 'no', kind: 'reject_once', name: 'Deny' }, { optionId: 'yes', kind: 'allow_once', name: 'Allow' }] } })
        break
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: account ? 'CONFIRMED-ACCOUNT-' + account : 'OK' } })
      send({ id, result: { stopReason: 'end_turn' } })
      break
    case 'session/cancel': send({ id: prompting, result: { stopReason: 'cancelled' } }); break
    default:
      if (id === 'permission') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.outcome.optionId ?? 'cancelled' } })
        send({ id: prompting, result: { stopReason: 'end_turn' } })
      }
  }
}

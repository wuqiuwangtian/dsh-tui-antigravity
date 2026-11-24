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
const configOptions = process.env.AGY_FIXTURE_CONFIG ? JSON.parse(process.env.AGY_FIXTURE_CONFIG) : undefined
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n')
const update = update => send({ method: 'session/update', params: { sessionId, update } })
let prompting
for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id, result } = JSON.parse(line)
  if (method && process.env.AGY_FIXTURE_RPC_LOG) {
    appendFileSync(process.env.AGY_FIXTURE_RPC_LOG, JSON.stringify({
      pid: process.pid, method, cwd: process.cwd(),
      skipPermissions: process.argv.includes('--dangerously-skip-permissions'),
      ...(params?.configId ? { configId: params.configId, value: params.value } : {}),
    }) + '\n')
  }
  switch (method) {
    case 'initialize': send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }); break
    case 'session/list':
      if (process.env.AGY_FIXTURE_WORKSPACE) {
        if (process.env.AGY_FIXTURE_STRICT_LIST && params?.cwd && params.cwd !== process.env.AGY_FIXTURE_WORKSPACE) {
          send({ id, result: { sessions: [] } })
          break
        }
        send({ id, result: params.cursor ? { sessions: [] } : {
          sessions: [{ sessionId, cwd: process.env.AGY_FIXTURE_WORKSPACE, title: 'catalog fixture' }], nextCursor: 'second',
        } })
        break
      }
      if (process.env.AGY_FIXTURE_EMPTY_CATALOG || (identities && !account)) { send({ id, result: { sessions: [] } }); break }
      send({ id, result: { sessions: [{ sessionId, cwd: process.cwd(), title: 'fixture' },
        { sessionId: 'foreign', cwd: '/another-project', title: 'other' }] } })
      break
    case 'session/load': send({ id, result: { sessionId, ...(configOptions ? { configOptions } : {}) } }); break
    case 'session/new':
      if (process.env.AGY_FIXTURE_SIGNIN || (identities && !account)) { send({ id, error: { code: -32000, message: 'Authentication required' } }); break }
      send({ id, result: { sessionId, ...(configOptions ? { configOptions } : {}) } }); break
    case 'session/set_config_option': {
      const option = configOptions?.find(o => o.id === params.configId)
      if (!option) { send({ id, error: { code: -32602, message: 'Unknown option' } }); break }
      option.currentValue = params.value
      send({ id, result: { configOptions } })
      break
    }
    case 'session/prompt': {
      const text = params.prompt[0].text
      if (text === 'steer-hang' && prompting !== undefined) break
      if (text === 'steer-fail' && prompting !== undefined) { send({ id, error: { code: -32603, message: 'busy' } }); break }
      if (text === 'steer-ok') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STEERED' } })
        send({ id, result: { stopReason: 'end_turn' } })
        break
      }
      prompting = id
      if (text === 'exit') process.exit(1)
      if (text === 'wait') break
      if (text === 'edit') {
        send({ id: 'permission', method: 'session/request_permission', params: { sessionId,
          toolCall: { toolCallId: 'edit', title: 'Edit file' },
          options: [{ optionId: 'no', kind: 'reject_once', name: 'Deny' }, { optionId: 'yes', kind: 'allow_once', name: 'Allow' }] } })
        break
      }
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: account ? 'CONFIRMED-ACCOUNT-' + account : 'OK' } })
      prompting = undefined
      send({ id, result: { stopReason: 'end_turn' } })
      break
    }
    case 'session/cancel':
      if (prompting !== undefined) {
        const activeId = prompting
        prompting = undefined
        send({ id: activeId, result: { stopReason: 'cancelled' } })
      }
      break
    default:
      if (id === 'permission') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.outcome.optionId ?? 'cancelled' } })
        const activeId = prompting
        prompting = undefined
        send({ id: activeId, result: { stopReason: 'end_turn' } })
      }
  }
}

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
let cancelDelayMs = 0
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
      if (text.startsWith('steer-handoff') && prompting !== undefined) {
        // Real agy acp protocol: resolve the previous in-flight session/prompt
        // immediately and transfer turn-completion ownership to the new steer.
        const prevId = prompting
        prompting = id
        send({ id: prevId, result: { stopReason: 'end_turn' } })
        if (text === 'steer-handoff-finish') {
          const activeId = id
          setTimeout(() => {
            if (prompting !== activeId) return
            update({ sessionUpdate: 'tool_call_update', toolCallId: 'step-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'STEP1_OK' } }] })
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HANDOFF_REPLY' } })
            prompting = undefined
            send({ id: activeId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 12, cachedReadTokens: 50 } } })
          }, 120)
        } else if (text === 'steer-handoff-partial-error') {
          const activeId = id
          setTimeout(() => {
            if (prompting !== activeId) return
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARTIAL_TEXT' } })
            setTimeout(() => {
              if (prompting !== activeId) return
              prompting = undefined
              send({ id: activeId, error: { code: -32001, message: 'connection interrupted' } })
            }, 30)
          }, 40)
        } else if (text === 'steer-handoff-slow-cancel') {
          cancelDelayMs = 300
        } else if (text === 'steer-handoff-streaming') {
          const activeId = id
          setTimeout(() => {
            if (prompting !== activeId) return
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STREAM_PART_1' } })
          }, 20)
        }
        break
      }
      if (text === 'steer-reject-after-chunk' && prompting !== undefined) {
        // First steer emits another chunk while still owning the turn, then rejects
        // this second steer with busy, and finally completes cleanly.
        const activeId = prompting
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STREAM_PART_2' } })
        setTimeout(() => {
          send({ id, error: { code: -32603, message: 'busy' } })
          setTimeout(() => {
            if (prompting !== activeId) return
            prompting = undefined
            send({ id: activeId, result: { stopReason: 'end_turn' } })
          }, 30)
        }, 20)
        break
      }
      prompting = id
      if (text === 'exit') process.exit(1)
      if (text === 'wait') break
      if (text === 'slow-ok') {
        const activeId = id
        setTimeout(() => {
          if (prompting !== activeId) return
          prompting = undefined
          send({ id: activeId, result: { stopReason: 'end_turn' } })
        }, 40)
        break
      }
      if (text === 'step-tool') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'step-1', kind: 'execute', name: 'run_command', title: 'sleep 3', status: 'in_progress' })
        break
      }
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
        const delay = cancelDelayMs
        cancelDelayMs = 0
        if (delay > 0) {
          setTimeout(() => {
            if (prompting !== activeId) return
            prompting = undefined
            send({ id: activeId, result: { stopReason: 'cancelled' } })
          }, delay)
        } else {
          prompting = undefined
          send({ id: activeId, result: { stopReason: 'cancelled' } })
        }
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

#!/usr/bin/env node
import { createInterface } from 'node:readline'
const sessionId = 'fixture-session'
const send = data => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n')
const update = update => send({ method: 'session/update', params: { sessionId, update } })
let prompting
for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id, result } = JSON.parse(line)
  switch (method) {
    case 'initialize': send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }); break
    case 'session/list':
      send({ id, result: { sessions: [{ sessionId, cwd: process.cwd(), title: 'fixture' },
        { sessionId: 'foreign', cwd: '/another-project', title: 'other' }] } })
      break
    case 'session/new': send({ id, result: { sessionId } }); break
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
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } })
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

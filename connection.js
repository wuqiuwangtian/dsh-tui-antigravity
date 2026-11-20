import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientApp, ndJsonStream } from '@agentclientprotocol/sdk'

export const executable = () => process.env.ANTIGRAVITY_EXECUTABLE || 'agy'

export async function connect(cwd, handlers = {}) {
  const app = new ClientApp()
  app.onNotification('session/update', ({ params }) => handlers.update?.(params))
  app.onRequest('session/request_permission', ({ params, signal }) =>
    handlers.permission?.(params, signal) ?? { outcome: { outcome: 'cancelled' } })
  if (handlers.elicit) app.onRequest('elicitation/create', ({ params, signal }) => handlers.elicit(params, signal))
  const child = spawn(executable(), ['acp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  child.once('error', error => connection.close(error))
  child.stdin.on('error', error => connection.close(error))
  const exited = new Promise(resolve => child.once('close', resolve))
  let closing
  function close() {
    if (!closing) {
      connection.close()
      child.kill()
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      closing = exited.finally(() => clearTimeout(timer))
    }
    return closing
  }
  async function request(method, params, options) {
    // ACP request cancellation is cooperative. A setup timeout must also
    // close the transport when the child cannot answer it.
    const signal = options?.signal
    const abort = () => connection.close(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      return await connection.agent.request(method, params)
    } finally { signal?.removeEventListener('abort', abort) }
  }
  try {
    const hello = await request('initialize', { protocolVersion: 1, clientCapabilities: handlers.elicit ? { elicitation: { form: {} } } : {} }, { signal: AbortSignal.timeout(20000) })
    if (hello.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
    return { hello, request, notify: (m, p) => connection.agent.notify(m, p), close, closed: connection.closed }
  } catch (error) {
    await close()
    throw error
  }
}

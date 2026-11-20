import { randomUUID } from 'node:crypto'
import { connect } from './connection.js'

const cancelled = () => ({ outcome: { outcome: 'cancelled' } })
const deadline = () => ({ signal: AbortSignal.timeout(30000) })

export class Session {
  constructor(cwd) {
    this.cwd = cwd
    this.status = 'starting'
    this.events = []
    this.listeners = new Set()
    this.permissions = new Map()
    this.tools = new Map()
    this.blocks = []
    this.queue = []
    this.commands = []
    this.turn = this.seq = this.step = 0
    this.capabilities = {
      native: {},
      pendingRetraction: { remove: id => this.removePending(id) },
      permissions: { pending: () => [...this.permissions.values()].map(p => p.view),
        respond: (id, decision) => this.respond(id, decision) },
      commands: { list: async () => this.commands },
      diagnostics: { lines: () => [
        'Antigravity ACP ' + (this.rpc?.hello.agentInfo?.version ?? ''),
        'Workspace: ' + this.cwd,
        'Session: ' + (this.id ?? ''),
      ] },
    }
  }

  async open(target) {
    this.id = target.sessionId
    this.rpc = await connect(this.cwd, {
      update: p => { if (!this.id || this.id === p.sessionId) this.update(p.update) },
      permission: (p, signal) => this.permission(p, signal),
    })
    try {
      const loading = target.kind === 'resume'
      const data = await this.rpc.request(loading ? 'session/load' : 'session/new',
        { cwd: this.cwd, mcpServers: [], sessionId: this.id }, deadline())
      if (loading && data.sessionId && data.sessionId !== this.id) throw new Error('Antigravity returned a different session ID.')
      this.id ??= data.sessionId
      if (!this.id) throw new Error('Antigravity did not return a session ID.')
      this.ref = { backendId: 'antigravity', sessionId: this.id }
      this.flush()
      this.configure(data.configOptions ?? [])
      if (this.rpc.hello.agentCapabilities?.promptCapabilities?.image) {
        this.capabilities.images = { limits: { mediaTypes: ['image/png','image/jpeg','image/webp'],
          maxImageBytes: 5_000_000, maxMessageImageBytes: 12_000_000, maxImagesPerMessage: 8,
          maxImageDimension: 4096, maxImagePixels: 16_777_216 } }
      }
      this.events.unshift({ type: 'session.ready', sessionId: this.id, cwd: this.cwd,
        model: this.option('model')?.currentValue ?? '', provider: 'Antigravity',
        effort: this.option('thought_level')?.currentValue, permissionMode: this.option('mode')?.currentValue })
      this.setStatus('idle')
      if (!loading) this.openingEvents = this.events.slice()
      this.rpc.closed.then(() => {
        this.clearQueue('dropped')
        this.dismiss()
        this.setStatus('disposed')
      })
    } catch (error) {
      await this.rpc.close()
      if (error.code === -32000 || /unauthenticated|authentication required/i.test(error.message)) throw new Error('Antigravity requires sign-in. Run agy acp --login and reopen.', { cause: error })
      throw error
    }
  }

  option(id) { return this.settings?.find(s => s.id === id) }
  choices(id) { return (this.option(id)?.options ?? []).flatMap(o => o.options ?? [o]).map(o => ({ id: o.value, label: o.name, description: o.description })) }
  configure(settings) {
    this.settings = settings
    for (const [id, capability] of [['model', 'models'], ['thought_level', 'effort'], ['mode', 'modes']]) {
      if (!this.option(id)) delete this.capabilities[capability]
    }
    if (this.option('model')) this.capabilities.models = {
      current: () => ({ model: this.option('model').currentValue }), list: async () => this.choices('model'),
      set: async ({ model }) => {
        try { await this.setOption('model', model); return { kind: 'switched' } }
        catch (e) { return { kind: 'refused', reason: e.message } }
      },
    }
    if (this.option('thought_level')) this.capabilities.effort = {
      current: () => this.option('thought_level').currentValue, levels: () => this.choices('thought_level'),
      set: id => this.setOption('thought_level', id),
    }
    if (this.option('mode')) this.capabilities.modes = {
      current: () => this.option('mode').currentValue, list: () => this.choices('mode'),
      cycle: () => this.choices('mode').filter(o => o.id === 'default'),
      set: id => this.setOption('mode', id),
    }
  }
  async setOption(id, value) {
    if (!this.choices(id).some(o => o.id === value)) throw new Error('Unavailable Antigravity option')
    const result = await this.rpc.request('session/set_config_option', { sessionId: this.id, configId: id, value }, deadline())
    this.configure(result.configOptions)
    const actual = this.option(id)?.currentValue
    if (id === 'model') this.emit({ type: 'model.changed', model: actual, source: 'user' })
    if (id === 'thought_level') this.emit({ type: 'effort.changed', effort: actual })
    if (id === 'mode') this.emit({ type: 'mode.changed', modeId: actual })
  }
  emit(event) {
    if (event.type !== 'assistant.delta') this.events.push(event)
    for (const listener of this.listeners) listener([event], { replay: false, wake: event.type === 'assistant.delta' ? 'frame' : 'sync' })
  }
  setStatus(status) {
    this.status = status
    this.emit({ type: 'session.status', status })
  }
  async history() { return this.events.slice() }
  subscribe(listener) {
    this.listeners.add(listener)
    if (this.openingEvents) {
      const events = this.openingEvents
      this.openingEvents = undefined
      listener(events, { replay: false })
    }
    return () => this.listeners.delete(listener)
  }
  pending(change) {
    this.emit({ type: 'pending.changed', items: this.queue.map(({ input }) => ({
      id: input.clientMessageId, text: input.text, placement: 'followup',
    })), ...change })
  }
  removePending(id) {
    const index = this.queue.findIndex(({ input }) => input.clientMessageId === id)
    if (index < 0) return false
    this.queue.splice(index, 1)
    this.pending({ discarded: [id] })
    return true
  }
  clearQueue(key) {
    const ids = this.queue.splice(0).map(({ input }) => input.clientMessageId)
    if (ids.length) this.pending({ [key]: ids })
  }

  flush() {
    if (!this.blocks.length) return
    const seq = ++this.seq
    this.emit({ type: 'assistant.message', seq, anchor: String(seq), turn: this.turn, step: this.step,
      attemptId: this.attempt, time: Date.now(), blocks: this.blocks, canonical: true })
    this.emit({ type: 'assistant.attempt.end', attemptId: this.attempt, outcome: 'committed', turn: this.turn, step: this.step })
    this.blocks = []
  }
  user(text, id, blocks, images) {
    this.flush()
    this.turn++
    this.step = 0
    this.emit({ type: 'turn.start', turn: this.turn, origin: 'user', userMessageId: id, time: Date.now() })
    this.emit({ type: 'user.message', seq: ++this.seq, anchor: id, id, time: Date.now(), turn: this.turn, source: 'user', text, blocks, images })
  }
  update(u) {
    if (this.status === 'disposed') return
    const messageChunk = u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk'
    if (messageChunk && this.status === 'idle') return
    if (messageChunk && u.messageId && u.messageId !== this.messageId) {
      this.flush()
      this.messageId = u.messageId
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (u.content?.type !== 'text' || !u.content.text) return
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning'
        if (!this.blocks.length) {
          this.attempt = randomUUID()
          this.emit({ type: 'assistant.attempt.start', attemptId: this.attempt, turn: this.turn, step: ++this.step })
        }
        if (this.blocks.at(-1)?.type !== kind) this.blocks.push({ type: kind, text: '' })
        this.blocks.at(-1).text += u.content.text
        this.emit({ type: 'assistant.delta', attemptId: this.attempt, index: this.blocks.length - 1, time: Date.now(),
          turn: this.turn, step: this.step, delta: { kind, text: u.content.text } })
        break
      }
      case 'user_message_chunk':
        if (this.status === 'starting' && u.content?.type === 'text') this.user(u.content.text, randomUUID(), [u.content])
        break
      case 'tool_call':
      case 'tool_call_update': {
        this.flush()
        const callId = u.toolCallId
        if (!this.tools.has(callId)) {
          this.tools.set(callId, false)
          this.emit({ type: 'tool.call', seq: ++this.seq, turn: this.turn, step: this.step, callId,
            name: u.title || u.kind || 'Tool', presentation: toolView(u), argsJson: JSON.stringify(u.rawInput ?? u.locations ?? {}), time: Date.now() })
        }
        const output = toolText(u)
        if (u.status === 'completed' || u.status === 'failed') {
          if (this.tools.get(callId)) break
          this.tools.set(callId, true)
          this.emit({ type: 'tool.result', seq: ++this.seq, turn: this.turn, step: this.step, callId, time: Date.now(),
            isError: u.status === 'failed', presentation: toolView(u), text: output, content: [{ type: 'text', text: output }] })
        } else if (output) this.emit({ type: 'tool.output', callId, text: output, time: Date.now() })
        break
      }
      case 'available_commands_update':
        this.commands = u.availableCommands.map(c => ({ name: c.name, description: c.description }))
        this.emit({ type: 'commands.changed', commands: this.commands })
        break
      case 'config_option_update': this.configure(u.configOptions); break
      case 'session_info_update': if (u.title) this.emit({ type: 'session.title', title: u.title, source: 'auto' }); break
      case 'plan': this.emit({ type: 'todo.write', items: u.entries.map(({ content, status }) => ({ content, status })) }); break
      case 'usage_update':
        this.usage = { used: u.used, max: u.size, categories: [] }
        this.capabilities.context = { usage: async () => this.usage }
        this.emit({ type: 'context.usage', used: u.used, max: u.size })
        break
    }
  }

  permission({ sessionId, toolCall, options }, signal) {
    if (sessionId !== this.id || this.status === 'disposed' || this.cancelling || signal?.aborted) return cancelled()
    const kinds = { allow_once: 'allow-once', allow_always: 'allow-always', reject_once: 'reject' }
    const choices = options.filter(o => kinds[o.kind]).map(o => ({ id: o.optionId, label: o.name, kind: kinds[o.kind] }))
    if (!choices.some(o => o.kind === 'reject')) choices.unshift({ id: '', label: 'Cancel', kind: 'reject' })
    const requestId = randomUUID()
    const view = { requestId, callId: toolCall.toolCallId, toolName: toolCall.title || toolCall.kind || 'Tool',
      input: toolCall.rawInput, description: toolText(toolCall), options: choices, defaultToNo: true }
    return new Promise(resolve => {
      const abort = () => this.respond(requestId)
      signal?.addEventListener('abort', abort, { once: true })
      this.permissions.set(requestId, { view, resolve: result => {
        signal?.removeEventListener('abort', abort)
        resolve(result)
      } })
      this.setStatus('requires-action')
      this.emit({ type: 'permission.request', request: view })
    })
  }
  respond(id, decision) {
    const item = this.permissions.get(id)
    if (!item) return
    const choice = item.view.options.find(o => o.kind === decision?.kind && (!decision.optionId || o.id === decision.optionId))
    this.permissions.delete(id)
    item.resolve(choice?.id ? { outcome: { outcome: 'selected', optionId: choice.id } } : cancelled())
    this.emit({ type: 'permission.settled', requestId: id, outcome: choice?.kind === 'reject' ? 'rejected' : choice?.kind ?? 'cancelled' })
    if (!this.permissions.size && this.status === 'requires-action') this.setStatus('running')
  }
  dismiss() { for (const id of this.permissions.keys()) this.respond(id) }

  async submit(input, placement = 'turn') {
    if (this.status !== 'idle' && this.status !== 'disposed' && placement === 'followup') {
      this.queue.push({ input })
      this.pending({})
      return { accepted: true }
    }
    if (this.status !== 'idle') return { accepted: false, dropped: true, reason: 'Antigravity session is busy or disconnected.' }
    this.setStatus('running')
    this.active = this.run(input)
    return { accepted: true }
  }
  async run(input) {
    let reason, usage
    const blocks = input.blocks ?? [{ type: 'text', text: input.text }]
    this.pending({ claimed: [input.clientMessageId] })
    this.user(input.text, input.clientMessageId, blocks, input.images)
    try {
      const prompt = blocks.filter(b => b.type === 'text').map(b => ({ type: 'text', text: b.text }))
      for (const image of input.images ?? []) prompt.push({ type: 'image', mimeType: image.mediaType ?? 'image/png', data: Buffer.from(await image.read()).toString('base64') })
      if (this.cancelling) reason = { kind: 'interrupted' }
      else {
        const result = await this.rpc.request('session/prompt', { sessionId: this.id, prompt })
        reason = result.stopReason === 'cancelled' ? { kind: 'interrupted' } : result.stopReason === 'end_turn' ? { kind: 'completed' } : { kind: 'other', label: result.stopReason }
        if (result.usage) usage = { input: result.usage.inputTokens, output: result.usage.outputTokens, cacheRead: result.usage.cachedReadTokens }
      }
    } catch (e) { reason = { kind: 'error', message: e.message } }
    finally {
      this.flush()
      this.dismiss()
      this.emit({ type: 'turn.end', turn: this.turn, time: Date.now(), reason, usage })
      this.cancelling = false
      if (this.status !== 'disposed' && !this.disposing) {
        this.setStatus('idle')
        const next = this.queue.shift()
        if (next) void this.submit(next.input)
      }
    }
  }
  async cancel(cause) {
    if (cause !== 'user') this.clearQueue('discarded')
    const remaining = () => this.queue.map(({ input }) => input.clientMessageId)
    if (this.status === 'disposed') return { stillQueued: remaining(), outcome: 'unknown' }
    if (this.status === 'idle') return { stillQueued: [], outcome: 'confirmed' }
    this.cancelling = true
    this.dismiss()
    await this.rpc.notify('session/cancel', { sessionId: this.id })
    let timer
    try {
      const done = await Promise.race([this.active.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
      return { stillQueued: remaining(), outcome: done ? 'confirmed' : 'unknown' }
    } finally { clearTimeout(timer) }
  }
  async dispose() {
    this.disposing = true
    this.setStatus('disposed')
    this.clearQueue('dropped')
    this.dismiss()
    await this.rpc.close()
    this.listeners.clear()
  }
}

function toolView(u) {
  const diffs = (u.content ?? []).filter(c => c.type === 'diff').map(c =>
    ({ path: c.path, oldText: c.oldText ?? null, newText: c.newText }))
  if (diffs.length) return { card: 'diff', diffs, title: u.title ?? diffs[0].path }
  if (u.kind === 'execute') return { card: 'terminal', title: u.title ?? 'Terminal' }
}

function toolText(u) {
  const text = (u.content ?? []).map(c => c.type === 'diff'
    ? [c.path, '---', c.oldText, '+++', c.newText].join('\n')
    : c.content?.text).filter(Boolean).join('\n')
  return text || (u.rawOutput == null ? '' : JSON.stringify(u.rawOutput))
}

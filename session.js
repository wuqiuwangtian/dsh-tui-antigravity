import { randomUUID } from 'node:crypto'
import { manage } from './management.js'
import { mcpControl } from './mcp.js'
import { elicit } from './forms.js'
import { Panels } from './panels.js'
import { readReport, reports } from './reports.js'
import { googleLogin } from './login.js'
import { connect } from './connection.js'

const cancelled = () => ({ outcome: { outcome: 'cancelled' } })
const sessionReports = {
  diff: '查看本会话由 agy 报告的文件编辑',
  commands: '查看当前 ACP 会话提供的原生命令',
  account: '查看当前账号的原生套餐',
}
const reportLabels = { ...reports, ...sessionReports }
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
    this.steers = new Set()
    this.localCommands = Object.entries(reportLabels).map(([name, description]) => ({ name, description }))
    this.localCommands.push({ name: 'agy', description: 'Antigravity 功能面板' }, { name: 'plan', description: '切换原生计划模式' })
    this.nativeCommands = []
    this.commands = this.localCommands
    this.panels = new Panels(event => this.emit(event))
    this.turn = this.seq = this.step = 0
    this.capabilities = {
      native: {},
      questions: this.panels.questions,
      mcp: mcpControl(cwd),
      auth: {
        status: async () => ({ lines: [this.needsLogin ? '需要 Google 授权' : '使用 agy 本机登录'] }),
        login: () => this.login(),
        reconnect: () => this.reconnect(),
      },
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
    this.rpc = await this.connectAgent()
    try {
      const loading = target.kind === 'resume'
      const data = await this.rpc.request(loading ? 'session/load' : 'session/new',
        { cwd: this.cwd, mcpServers: [], sessionId: this.id }, deadline())
      if (loading && data.sessionId && data.sessionId !== this.id) throw new Error('Antigravity returned a different session ID.')
      this.id ??= data.sessionId
      if (!this.id) throw new Error('Antigravity did not return a session ID.')
      this.ref = { backendId: 'antigravity', sessionId: this.id }
      this.flush()
      this.configureAccount(data)
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
      this.watchConnection(this.rpc)
    } catch (error) {
      await this.rpc.close()
      if (error.code === -32000 || /unauthenticated|authentication required/i.test(error.message)) {
        this.enterLogin(target)
        return
      }
      throw error
    }
  }

  connectAgent() {
    return connect(this.cwd, {
      update: p => { if (!this.suppressReplay && (!this.id || this.id === p.sessionId)) this.update(p.update) },
      elicit: (p, signal) => this.elicit(p, signal),
      permission: (p, signal) => this.permission(p, signal),
    })
  }

  watchConnection(rpc) {
    rpc.closed.then(() => {
      if (this.rpc !== rpc) return
      this.localAction?.abort()
      this.panels.close()
      this.clearQueue('dropped')
      this.dismiss()
      this.setStatus('disposed')
    })
  }

  elicit(request, signal) {
    if (request.sessionId !== this.id || this.disposing || this.cancelling) return { action: 'cancel' }
    return elicit(this.panels, request, signal)
  }

  enterLogin(target) {
    this.needsLogin = true
    this.loginTarget = target
    this.ref = { backendId: 'antigravity', sessionId: 'signin-' + randomUUID() }
    this.status = 'idle'
    this.openingEvents = [{ type: 'notice', level: 'info', text: '运行 /login 登录已有 Google 账号。' }]
  }

  async reconnect() {
    if (!this.id || this.needsLogin) return
    const next = await this.connectAgent()
    this.suppressReplay = true
    try {
      let cursor
      let found
      const cursors = new Set()
      do {
        const page = await next.request('session/list', { cwd: this.cwd, cursor }, deadline())
        found = page.sessions.some(row => row.sessionId === this.id && row.cwd === this.cwd)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Repeated ACP catalog cursor')
        cursors.add(cursor)
      } while (!found && cursor)
      if (!found) throw new Error('此账号的会话目录中没有原会话。请运行 /new 开始新会话。')
      const data = await next.request('session/load', { cwd: this.cwd, sessionId: this.id, mcpServers: [] }, deadline())
      if (this.disposing || (data.sessionId && data.sessionId !== this.id)) throw new Error('会话已关闭或发生变化。')
      const old = this.rpc
      this.configureAccount(data)
      this.configure(data.configOptions ?? [])
      this.rpc = next
      this.watchConnection(next)
      await old.close()
    } catch (error) {
      await next.close()
      throw error
    } finally { this.suppressReplay = false }
    this.emit({ type: 'session.ready', sessionId: this.id, cwd: this.cwd, model: this.option('model')?.currentValue ?? '' })
  }

  async login() {
    if (this.localAction || this.status !== 'idle') throw new Error('请先结束当前操作。')
    const action = new AbortController()
    this.localAction = action
    try {
      if (!await googleLogin(this.cwd, this.panels, action.signal)) return
      // A first login has no native conversation ID yet. /new lets the
      // host acquire the real session lock instead of reusing a stand-in.
      if (this.needsLogin) {
        const resume = this.loginTarget?.kind === 'resume'
        this.emit({ type: 'notice', level: 'info', text: resume
          ? '已登录，请从会话选择器恢复原会话。' : '已登录。运行 /new 开始 Antigravity 会话。' })
      } else {
        this.authChanged = true
        await this.reconnect()
        this.authChanged = false
        this.emit({ type: 'notice', level: 'info', text: 'Google 授权完成，会话已重新连接。' })
      }
    } catch (e) {
      if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: e.message })
    } finally { this.localAction = undefined }
  }

  async showMenu(action) {
    try {
      const entries = [...Object.keys(reportLabels).filter(name => name !== 'quota'), 'plugins', 'mcp']
      const answer = await this.panels.ask([{ header: 'Antigravity', question: '选择要查看的功能',
        options: entries.map(name => ({ label: '/' + name, description: reportLabels[name] ?? (name === 'plugins' ? '管理原生插件' : '管理原生 MCP 服务') })), hideCustomInput: true }], action.signal)
      const name = answer?.[0]?.selected?.[0]?.slice(1)
      if (['plugins', 'mcp'].includes(name)) await manage(name, this.cwd, this.panels, action.signal)
      else if (entries.includes(name)) await this.showReport(name, action)
    } catch {
      if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: '操作未完成。请检查本地 agy 配置。' })
    } finally { this.localAction = undefined }
  }

  async report(name, signal) {
    if (name === 'account') {
      const info = await this.capabilities.account?.info()
      return { text: (info?.subscription ? '套餐 · ' + info.subscription : '当前会话未提供套餐信息') +
        '\n登录和切换已有 Google 账号请使用 /login。' }
    }
    if (name === 'commands') return { text: this.nativeCommands.map(c => '/agy ' + c.name + '  ' + c.description).join('\n') || '当前会话尚未上报原生命令。' }
    if (name === 'diff') {
      const changes = []
      for (const event of this.events) {
        const view = event.presentation
        if (event.type !== 'tool.result' || event.isError || view?.card !== 'diff') continue
        for (const diff of view.diffs) changes.push(diff.path + '\n---\n' + (diff.oldText ?? '') + '\n+++\n' + diff.newText)
      }
      return { text: changes.join('\n\n') || '当前会话没有可显示的已完成编辑。' }
    }
    return readReport(name, this.cwd, signal)
  }

  async showReport(name, action) {
    try {
      do {
        this.emit({ type: 'notice', level: 'info', text: '正在查询 Antigravity /' + name + '…' })
        let detail
        try {
          const report = await this.report(name, action.signal)
          detail = report.text
          if (report.windows) this.emit({ type: 'rate-limit', info: { windows: report.windows } })
        } catch (error) { detail = error.message }
        if (action.signal.aborted) break
        const lines = detail.split('\n')
        const size = 12
        const pages = Math.ceil(lines.length / size)
        let page = 0
        let choice
        do {
          const options = ['关闭', '刷新']
          if (page > 0) options.push('上一页')
          if (page + 1 < pages) options.push('下一页')
          const answer = await this.panels.ask([{ header: 'Antigravity',
            question: '/' + name + ' · ' + reportLabels[name] + (pages > 1 ? ' · ' + (page + 1) + '/' + pages : ''),
            detail: lines.slice(page * size, (page + 1) * size).join('\n'),
            options: options.map(label => ({ label })), hideCustomInput: true }], action.signal)
          choice = answer?.[0]?.selected?.[0]
          if (choice === '上一页') page--
          if (choice === '下一页') page++
        } while (!action.signal.aborted && (choice === '上一页' || choice === '下一页'))
        if (choice !== '刷新') break
      } while (!action.signal.aborted)
    } finally { this.localAction = undefined }
  }

  configureAccount(data) {
    const tier = data._meta?.antigravity?.tier?.name
    this.capabilities.account = { info: async () => ({ provider: 'Google Antigravity', tokenSource: 'agy', subscription: tier }) }
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
    // Dialogs can contain a one-time auth URL. Never retain them for replay.
    if (!['assistant.delta', 'question.request', 'question.settled'].includes(event.type)) this.events.push(event)
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
        this.nativeCommands = u.availableCommands
        const names = new Set(this.localCommands.map(c => c.name))
        this.commands = [...this.localCommands, ...u.availableCommands.filter(c => !names.has(c.name))]
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
    if (this.localAction) return { accepted: false, dropped: true, reason: '请先完成或关闭当前面板。' }
    const text = input.text.trim()
    const name = text.replace(/^\/agy\s+/, '/').slice(1)
    if (text === '/agy' && this.status === 'idle') {
      this.pending({ claimed: [input.clientMessageId] })
      this.localAction = new AbortController()
      void this.showMenu(this.localAction)
      return { accepted: true }
    }
    if (input.text.trim().startsWith('/') && Object.hasOwn(reportLabels, name) && this.status === 'idle') {
      this.pending({ claimed: [input.clientMessageId] })
      this.localAction = new AbortController()
      void this.showReport(name, this.localAction)
      return { accepted: true }
    }
    if (['agy mcp', 'agy plugins'].includes(text.slice(1)) && this.status === 'idle') {
      this.pending({ claimed: [input.clientMessageId] })
      const action = new AbortController()
      this.localAction = action
      void manage(name, this.cwd, this.panels, action.signal).catch(() => {
        if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: 'Antigravity 配置操作失败。' })
      }).finally(() => { this.localAction = undefined })
      return { accepted: true }
    }
    if (/^\/agy\s/.test(text)) {
      const command = name.split(/\s+/, 1)[0]
      if (!this.nativeCommands.some(c => c.name === command)) return { accepted: false, dropped: true, reason: '当前 agy 未提供此命令。输入 /agy 查看可用面板。' }
      input = { ...input, text: '/' + name, blocks: [{ type: 'text', text: '/' + name }, ...(input.blocks?.slice(1) ?? [])] }
    }
    if (/^\/plan(?:\s|$)/.test(text) && this.status === 'idle' && this.capabilities.modes) {
      const argument = text.slice(5).trim()
      await this.setOption('mode', argument === 'off' ? 'default' : 'plan')
      if (!argument || argument === 'on' || argument === 'off') {
        this.pending({ claimed: [input.clientMessageId] })
        return { accepted: true }
      }
      input = { ...input, text: argument, blocks: [{ type: 'text', text: argument }, ...(input.blocks?.slice(1) ?? [])] }
    }
    if (this.needsLogin || this.authChanged) return { accepted: false, dropped: true, reason: '请使用 /login 登录，再用 /new 或会话选择器进入原生会话。' }
    if (this.status === 'running' && placement === 'steer' && this.acceptSteers && !this.cancelling) {
      const steered = this.steer(input)
      this.steers.add(steered)
      void steered.finally(() => this.steers.delete(steered))
      return { accepted: true }
    }
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
  async steer(input) {
    const blocks = input.blocks ?? [{ type: 'text', text: input.text }]
    try {
      const prompt = await this.promptBlocks(blocks, input.images)
      if (this.cancelling || this.disposing) {
        this.pending({ dropped: [input.clientMessageId] })
        return
      }
      this.pending({ claimed: [input.clientMessageId] })
      this.emit({ type: 'user.message', seq: ++this.seq, anchor: input.clientMessageId, id: input.clientMessageId,
        time: Date.now(), turn: this.turn, source: 'user', text: input.text, blocks, images: input.images })
      await this.rpc.request('session/prompt', { sessionId: this.id, prompt })
    } catch {
      if (!this.disposing) this.emit({ type: 'notice', level: 'error', text: 'Antigravity 未确认引导消息的执行结果。' })
    }
  }

  async promptBlocks(blocks, images) {
    const prompt = blocks.filter(b => b.type === 'text').map(b => ({ type: 'text', text: b.text }))
    for (const image of images ?? []) prompt.push({ type: 'image', mimeType: image.mediaType ?? 'image/png', data: Buffer.from(await image.read()).toString('base64') })
    return prompt
  }
  async run(input) {
    let reason, usage
    const blocks = input.blocks ?? [{ type: 'text', text: input.text }]
    this.pending({ claimed: [input.clientMessageId] })
    this.user(input.text, input.clientMessageId, blocks, input.images)
    try {
      const prompt = await this.promptBlocks(blocks, input.images)
      if (this.cancelling) reason = { kind: 'interrupted' }
      else {
        this.acceptSteers = true
        const result = await this.rpc.request('session/prompt', { sessionId: this.id, prompt })
        reason = result.stopReason === 'cancelled' ? { kind: 'interrupted' } : result.stopReason === 'end_turn' ? { kind: 'completed' } : { kind: 'other', label: result.stopReason }
        if (result.usage) usage = { input: result.usage.inputTokens, output: result.usage.outputTokens, cacheRead: result.usage.cachedReadTokens }
      }
    } catch (e) { reason = { kind: 'error', message: e.message } }
    finally {
      this.acceptSteers = false
      await Promise.allSettled(this.steers)
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
    this.localAction?.abort()
    this.panels.close()
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
    this.localAction?.abort()
    this.panels.close()
    this.setStatus('disposed')
    this.clearQueue('dropped')
    this.dismiss()
    await this.rpc?.close()
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

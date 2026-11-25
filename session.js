import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { viewTeam } from './team.js'
import { viewArtifacts } from './artifacts.js'
import { codeSearch } from './search.js'
import { editSetting } from './settings.js'
import { manage, managers } from './management.js'
import { mcpControl } from './mcp.js'
import { elicit } from './forms.js'
import { localTranscriptImage, markdownImages, transcriptImage } from './images.js'
import { Panels } from './panels.js'
import { readReport, reports } from './reports.js'
import { googleLogin } from './login.js'
import { connect, normalizeWorkspaceCwd } from './connection.js'

const cancelled = () => ({ outcome: { outcome: 'cancelled' } })
const sessionReports = {
  diff: '查看本会话由 agy 报告的文件编辑',
  tasks: '查看本会话的计时器、动态工作流和后台智能体调用',
  commands: '查看当前 ACP 会话提供的原生命令',
  account: '查看当前账号的原生套餐',
  native: '在官方 CLI 打开同一会话',
}
const interactiveReports = new Set(['agents', 'account', 'config', 'permissions'])
const quotaCacheMs = 60_000
async function credentialStamp() {
  try {
    const file = await stat(join(homedir(), '.gemini/antigravity-cli/antigravity-oauth-token'), { bigint: true })
    return file.ino + ':' + file.ctimeNs
  } catch { return undefined }
}
const reportLabels = { ...reports, ...sessionReports }
const actionLabels = { ...managers, team: '读取当前会话的子代理回复', folders: '本次会话的附加目录', codesearch: '搜索当前工作区', artifacts: '预览当前会话的 Markdown 产物' }
const FULL_ACCESS_MODE = 'full-access'
const fullAccessOption = {
  id: FULL_ACCESS_MODE,
  label: 'Full access',
  description: 'Auto-approve all tool permission requests (--dangerously-skip-permissions); explicit selection only.',
}
const deadline = () => ({ signal: AbortSignal.timeout(30000) })

export class Session {
  constructor(cwd, { agent, stageAgent, prefs } = {}) {
    this.cwd = cwd
    this.agent = agent
    this.stageAgent = stageAgent
    this.prefs = prefs
    this.baseMode = prefs?.read().mode
    this.skipPermissions = this.baseMode === FULL_ACCESS_MODE
    this.status = 'starting'
    this.events = []
    this.listeners = new Set()
    this.permissions = new Map()
    this.tools = new Map()
    this.blocks = []
    this.replyImages = []
    this.replyImagePaths = new Set()
    this.queue = []
    this.directories = []
    this.steered = new Map()
    this.steers = new Set()
    this.reportQueries = new Map()
    this.reportPages = new Map()
    this.localCommands = Object.entries(reportLabels).map(([name, description]) => ({ name, description }))
    this.localCommands.push({ name: 'artifacts', description: '预览当前会话的产物' }, { name: 'codesearch', description: '搜索工作区代码' }, { name: 'signin', description: '登录或切换已有 Google 账号' }, { name: 'agy', description: 'Antigravity 功能面板' }, { name: 'plan', description: '切换原生计划模式' })
    this.nativeCommands = []
    this.commands = this.localCommands
    this.panels = new Panels(event => this.emit(event))
    this.turn = this.seq = this.step = 0
    this.capabilities = {
      native: {},
      questions: this.panels.questions,
      mcp: mcpControl(cwd),
      auth: {
        status: async () => ({ lines: [this.authHint ?? '使用 agy 本机登录'] }),
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
        ...(this.skipPermissions ? ['Permissions: full-access (--dangerously-skip-permissions)'] : []),
      ] },
    }
  }

  async open(target, rpc) {
    this.id = target.sessionId
    this.rpc = rpc ?? await this.connectAgent()
    try {
      const loading = target.kind === 'resume'
      const data = await this.rpc.request(loading ? 'session/load' : 'session/new',
        { cwd: this.cwd, mcpServers: [], sessionId: this.id }, deadline())
      if (loading && data.sessionId && data.sessionId !== this.id) throw new Error('Antigravity returned a different session ID.')
      this.id ??= data.sessionId
      if (!this.id) throw new Error('Antigravity did not return a session ID.')
      this.flushReplayUser()
      this.ref = { backendId: 'antigravity', sessionId: this.id }
      this.flush()
      this.configureAccount(data)
      this.configure(data.configOptions ?? [])
      await this.applySavedPrefs()
      if (this.rpc.hello.agentCapabilities?.promptCapabilities?.image) {
        this.capabilities.images = { limits: { mediaTypes: ['image/png','image/jpeg','image/webp'],
          maxImageBytes: 5_000_000, maxMessageImageBytes: 12_000_000, maxImagesPerMessage: 8,
          maxImageDimension: 4096, maxImagePixels: 16_777_216 } }
      }
      this.events.unshift({ type: 'session.ready', sessionId: this.id, cwd: this.cwd,
        model: this.option('model')?.currentValue ?? '', provider: 'Antigravity',
        effort: this.option('thought_level')?.currentValue, permissionMode: this.currentMode() })
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

  connectAgent(directories = this.directories, receive = u => this.update(u), skipPermissions = this.skipPermissions) {
    return connect(this.cwd, {
      update: p => { if (!this.id || this.id === p.sessionId) receive(p.update) },
      elicit: (p, signal) => this.elicit(p, signal),
      permission: (p, signal) => this.permission(p, signal),
    }, directories, this.agent, { skipPermissions })
  }

  watchConnection(rpc) {
    rpc.closed.then(() => {
      if (this.rpc !== rpc) return
      this.clearReports()
      this.localAction?.abort()
      this.panels.close()
      this.clearPending('dropped')
      this.dismiss()
      this.setStatus('disposed')
    })
  }

  elicit(request, signal) {
    if (this.authHint || request.sessionId !== this.id || this.disposing || this.cancelling) return { action: 'cancel' }
    return elicit(this.panels, request, signal)
  }

  enterLogin(target) {
    this.needsLogin = true
    this.authHint = '运行 /login 登录已有 Google 账号。'
    this.loginTarget = target
    this.ref = { backendId: 'antigravity', sessionId: 'signin-' + randomUUID() }
    this.status = 'idle'
    this.openingEvents = [{ type: 'notice', level: 'info', text: this.authHint }]
  }

  async reconnect(directories = this.directories, checkAccount = true, options = {}) {
    if (!this.id || this.needsLogin) return
    if (!checkAccount && this.authHint) throw new Error(this.authHint)
    let attached = false, catalog
    const nextSkipPermissions = options.skipPermissions ?? this.skipPermissions
    const activePrefs = {
      model: this.option('model')?.currentValue ?? this.prefs?.read().model,
      effort: this.option('thought_level')?.currentValue ?? this.prefs?.read().effort,
      mode: options.mode ?? (nextSkipPermissions ? FULL_ACCESS_MODE : this.option('mode')?.currentValue ?? this.prefs?.read().mode),
    }
    const next = await this.connectAgent(directories, u => {
      if (attached) this.update(u)
      else if (u.sessionUpdate === 'available_commands_update') catalog = u
    }, nextSkipPermissions)
    try {
      const targetCwd = resolve(this.catalogCwd ?? this.cwd)
      const findInList = async (scopeCwd) => {
        let cursor
        const cursors = new Set()
        while (true) {
          const page = await next.request('session/list', { cwd: scopeCwd, cursor }, deadline())
          const rows = Array.isArray(page?.sessions) ? page.sessions : []
          if (rows.some(row => row.sessionId === this.id && (!row.cwd || resolve(normalizeWorkspaceCwd(row.cwd)) === targetCwd))) return true
          cursor = page?.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('Repeated ACP catalog cursor')
          cursors.add(cursor)
          if (!cursor) return false
        }
      }
      let found = !checkAccount || await findInList(targetCwd)
      if (!found && encodeURI(targetCwd) !== targetCwd) found = await findInList(undefined)
      if (!found) throw new Error('此账号的会话目录中没有原会话。请运行 /new 开始新会话。')
      const data = await next.request('session/load', { cwd: this.cwd, sessionId: this.id, mcpServers: [], additionalDirectories: directories }, deadline())
      if (this.disposing || (data.sessionId && data.sessionId !== this.id)) throw new Error('会话已关闭或发生变化。')
      const old = this.rpc
      this.skipPermissions = nextSkipPermissions
      this.configureAccount(data)
      this.configure(data.configOptions ?? [])
      await this.applySavedPrefs(activePrefs, next)
      this.rpc = next
      this.authHint = undefined
      attached = true
      this.update(catalog ?? { sessionUpdate: 'available_commands_update', availableCommands: [] })
      this.directories = directories
      this.watchConnection(next)
      await old?.close()
    } catch (error) {
      await next.close()
      throw error
    }
    this.emit({ type: 'session.ready', sessionId: this.id, cwd: this.cwd,
      model: this.option('model')?.currentValue ?? '',
      effort: this.option('thought_level')?.currentValue,
      permissionMode: this.currentMode() })
  }

  async login(action = new AbortController()) {
    if ((this.localAction && this.localAction !== action) || this.status !== 'idle') throw new Error('请先结束当前操作。')
    this.localAction = action
    this.clearReports()
    try {
      if (!await googleLogin(this.cwd, this.panels, action.signal)) return
      // A first login has no native conversation ID yet. /new lets the
      // host acquire the real session lock instead of reusing a stand-in.
      if (this.needsLogin) {
        const resume = this.loginTarget?.kind === 'resume'
        this.authHint = resume ? '已登录，请从会话选择器恢复原会话。' : '已登录。运行 /new 开始 Antigravity 会话。'
        this.emit({ type: 'notice', level: 'info', text: this.authHint })
      } else {
        // The native credential has already changed. Retire the previous
        // process even when the new credential cannot restore this session.
        this.authHint = 'Google 授权已完成。请运行 /new 或从会话选择器进入可用的原生会话。'
        const old = this.rpc
        this.rpc = undefined
        this.dismiss()
        this.configure([])
        delete this.capabilities.account
        delete this.capabilities.context
        await old?.close()
        await this.reconnect()
        this.emit({ type: 'notice', level: 'info', text: 'Google 授权完成，会话已重新连接。' })
      }
    } catch (e) {
      if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: e.message })
    } finally { this.localAction = undefined }
  }

  async showMenu(action) {
    try {
      const labels = { ...reportLabels, ...actionLabels }
      const names = Object.keys(labels).filter(name => name !== 'quota')
      const answer = await this.panels.ask([{ header: 'Antigravity', question: '选择要查看的功能',
        options: names.map(name => ({ label: '/' + name, description: labels[name] })), hideCustomInput: true }], action.signal)
      const name = answer?.[0]?.selected?.[0]?.slice(1)
      if (Object.hasOwn(actionLabels, name)) await this.showAction(name, action)
      else if (interactiveReports.has(name)) await this.showReport(name, action)
      else if (Object.hasOwn(reportLabels, name)) void this.printReport(name)
    } catch {
      if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: '操作未完成。请检查本地 agy 配置。' })
    } finally { this.localAction = undefined }
  }

  async showAction(name, action, argument) {
    if (name === 'artifacts' || name === 'team') {
      if (this.authHint) throw new Error(this.authHint)
      if (!this.id) throw new Error('请先登录并进入正式会话。')
      const view = name === 'team' ? viewTeam : viewArtifacts
      return view(this.id, this.panels, action.signal)
    }
    if (name === 'folders') return this.editFolders(action)
    if (name === 'codesearch') return codeSearch(this.cwd, this.panels, action.signal, argument)
    try { await manage(name, this.cwd, this.panels, action.signal) }
    catch { throw new Error('Antigravity 管理命令执行失败，请检查原生 CLI 状态。') }
  }

  async editFolders(action) {
    if (this.authHint) throw new Error(this.authHint)
    if (!this.id) throw new Error('请先登录并进入会话。')
    const signal = action.signal
    const choice = await this.panels.ask([{ header: '工作目录', question: '当前会话的附加工作目录',
      detail: [this.cwd, ...this.directories].join('\n'), options: [{ label: '关闭' }, { label: '添加目录' },
        ...this.directories.map(dir => ({ label: '移除 ' + dir }))], hideCustomInput: true }], signal)
    const selected = choice?.[0]?.selected?.[0]
    if (!selected || selected === '关闭') return
    let directories
    if (selected === '添加目录') {
      const entry = await this.panels.ask([{ header: '工作目录', question: '输入要授权本会话访问的目录', options: [] }], signal)
      const value = entry?.[0]?.custom?.trim()
      if (!value) return
      const dir = await realpath(resolve(this.cwd, value))
      if (dir === this.cwd || this.directories.includes(dir)) return
      if (!(await stat(dir)).isDirectory()) throw new Error('请选择一个目录。')
      const confirmation = await this.panels.ask([{ header: '工作目录', question: '允许 agy 在此目录工作？',
        detail: dir, options: [{ label: '返回' }, { label: '允许' }], hideCustomInput: true }], signal)
      if (confirmation?.[0]?.selected?.[0] !== '允许') return
      directories = [...this.directories, dir]
    } else {
      directories = this.directories.filter(dir => '移除 ' + dir !== selected)
    }
    if (!signal.aborted) await this.reconnect(directories, false)
  }

  async report(name, signal) {
    if (this.authHint && ['account', 'native', 'tasks', 'diff', 'commands'].includes(name)) return { text: this.authHint }
    if (name === 'account') {
      const info = await this.capabilities.account?.info()
      return { text: (info?.subscription ? '套餐 · ' + info.subscription : '当前会话未提供套餐信息') +
        '\n登录和切换已有 Google 账号请使用 /login。' }
    }
    if (name === 'native') {
      if (this.needsLogin || !this.id) return { text: '请先登录并进入正式会话。' }
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
      return { text: ['先退出当前写入端，再在终端运行', 'cd ' + quote(this.cwd),
        'agy --conversation ' + quote(this.id), '原生会话分叉用 /fork，改名用 /rename；/resume 中按 F4 删除。',
        '返回 dsh-TUI 时，退出 agy 后运行', 'dsh-tui --backend antigravity --resume ' + quote(this.id)].join('\n') }
    }
    if (name === 'commands') {
      const native = this.nativeCommands.map(c => '/agy ' + c.name + '  ' + (c.description ?? ''))
      return { text: ['当前会话 · ACP 原生命令', ...(native.length ? native : ['当前会话尚未上报原生命令。']),
        '', '报告与管理 · /agy <名称>', ...Object.entries({ ...reportLabels, ...actionLabels }).map(([id, label]) => id + '  ' + label)].join('\n') }
    }
    if (name === 'tasks') {
      const status = { pending: '等待中', in_progress: '运行中', completed: '已完成', failed: '失败' }
      const rows = [...this.tools.values()].filter(call => call.task)
      return { text: rows.reverse().map(call => [call.task.label, status[call.status], call.task.description].filter(Boolean).join(' · ')).join('\n') || '当前会话没有收到计时器、动态工作流或后台智能体调用。' }
    }
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

  clearReports() {
    for (const query of this.reportQueries.values()) query.abort()
    this.reportQueries.clear()
    this.reportPages.clear()
    this.lastQuota = undefined
  }

  printPage(name, page) {
    const lines = this.reportPages.get(name)
    if (!lines) {
      this.emit({ type: 'notice', level: 'info', text: '请先运行 /agy ' + name + '。' })
      return
    }
    const total = Math.ceil(lines.length / 24)
    if (page < 1 || page > total) {
      this.emit({ type: 'notice', level: 'error', text: '页码范围为 1–' + total })
      return
    }
    const start = (page - 1) * 24
    const next = page < total ? page + 1 : page - 1
    this.outputReport(name, lines.slice(start, start + 24).join('\n') +
      '\n第 ' + page + '/' + total + ' 页 · /agy ' + name + ' page ' + next)
  }

  outputReport(name, text) {
    const seq = ++this.seq
    const id = 'agy-report-' + seq
    this.emit({ type: 'user.message', source: 'command-output', displayLive: true, label: '/' + name,
      seq, id, anchor: id, time: Date.now(), text, blocks: [{ type: 'text', text }] })
  }

  async printReport(name, refresh = false) {
    const key = name === 'quota' ? 'usage' : name
    if (this.reportQueries.has(key)) {
      this.emit({ type: 'notice', level: 'info', text: '/' + key + ' 查询进行中。' })
      return
    }
    const query = new AbortController()
    this.reportQueries.set(key, query)
    const loading = setTimeout(() => {
      this.emit({ type: 'notice', level: 'info', text: '正在查询 /' + name + '…' })
    }, 200)
    try {
      const stamp = key === 'usage' ? await credentialStamp() : undefined
      if (query.signal.aborted) return
      const cached = this.lastQuota
      const reuse = key === 'usage' && stamp !== undefined && !refresh && cached && cached.stamp === stamp && Date.now() - cached.at < quotaCacheMs
      const report = reuse ? cached.report : await this.report(key, query.signal)
      if (query.signal.aborted) return
      let text = report.text
      if (key === 'usage') {
        if (!reuse) this.lastQuota = { report, at: Date.now(), stamp }
        text += '\n' + (reuse ? '缓存 · ' : '查询于 ') + new Date(this.lastQuota.at).toLocaleTimeString() + ' · /usage refresh 重新查询'
      }
      if (report.windows) this.emit({ type: 'rate-limit', info: { windows: report.windows } })
      // Headless changelogs can exceed 200k characters. Expose the complete
      // result by page while keeping a single transcript row bounded.
      const lines = text.split('\n').flatMap(line => line.match(/.{1,240}/gu) ?? [''])
      if (lines.length > 24) {
        this.reportPages.set(name, lines)
        this.printPage(name, 1)
      } else {
        this.reportPages.delete(name)
        this.outputReport(name, text)
      }
    } catch (error) {
      if (!query.signal.aborted) this.emit({ type: 'notice', level: 'error', text: '/' + name + ' · ' + error.message })
    } finally {
      clearTimeout(loading)
      if (this.reportQueries.get(key) === query) this.reportQueries.delete(key)
    }
  }

  async showReport(name, action) {
    try {
      do {
        const loading = new AbortController()
        const dialogSignal = AbortSignal.any([action.signal, loading.signal])
        const cancelled = this.panels.ask([{ header: 'Antigravity', question: '正在查询 /' + name + '…',
          options: [{ label: '取消' }], hideCustomInput: true }], dialogSignal).then(() => {
          if (!loading.signal.aborted) action.abort()
        })
        let detail, agents
        try {
          const report = await this.report(name, action.signal)
          detail = report.text
          agents = report.agents
        } catch (error) { detail = error.message }
        finally { loading.abort(); await cancelled }
        if (action.signal.aborted) break
        const lines = detail.split('\n')
        const size = 12
        const pages = Math.ceil(lines.length / size)
        let page = 0
        let choice
        do {
          const options = ['关闭', '刷新']
          if (name === 'account') options.push('登录或切换 Google 账号')
          if (name === 'config' || name === 'permissions') options.push('编辑全局设置')
          if (agents?.length && this.stageAgent) options.push('选择新会话智能体')
          if (page > 0) options.push('上一页')
          if (page + 1 < pages) options.push('下一页')
          const answer = await this.panels.ask([{ header: 'Antigravity',
            question: '/' + name + ' · ' + reportLabels[name] + (pages > 1 ? ' · ' + (page + 1) + '/' + pages : ''),
            detail: lines.slice(page * size, (page + 1) * size).join('\n'),
            options: options.map(label => ({ label })), hideCustomInput: true }], action.signal)
          choice = answer?.[0]?.selected?.[0]
          if (choice === '登录或切换 Google 账号') {
            await this.login(action)
            return
          }
          if (choice === '编辑全局设置') {
            try {
              if (await editSetting(this.panels, action.signal, name === 'permissions'))
                this.emit({ type: 'notice', level: 'info', text: '全局设置已保存。新 agy 进程将读取此设置。' })
            } catch (error) {
              this.emit({ type: 'notice', level: 'error', text: '未保存 · ' + error.message })
            }
            choice = '刷新'
          }
          if (choice === '选择新会话智能体') {
            const pick = await this.panels.ask([{ header: '智能体', question: '为下一次 /new 选择智能体',
              options: agents.map(label => ({ label })), hideCustomInput: true }], action.signal)
            const selected = pick?.[0]?.selected?.[0]
            if (agents.includes(selected)) {
              this.stageAgent(selected)
              this.emit({ type: 'notice', level: 'info', text: '运行 /new 使用 ' + selected + '。' })
            }
          }
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
  modeChoices() {
    const native = this.choices('mode')
    if (!native.length || native.some(o => o.id === FULL_ACCESS_MODE)) return native
    const planIndex = native.findIndex(o => o.id === 'plan')
    if (planIndex < 0) return [...native, fullAccessOption]
    return [...native.slice(0, planIndex), fullAccessOption, ...native.slice(planIndex)]
  }
  currentMode() {
    const acpMode = this.option('mode')?.currentValue
    if (!acpMode) return undefined
    if (acpMode === 'plan') return 'plan'
    return this.skipPermissions ? FULL_ACCESS_MODE : acpMode
  }
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
    if (this.option('mode')) {
      const activeMode = this.currentMode()
      if (activeMode && activeMode !== 'plan') this.baseMode = activeMode
      this.capabilities.modes = {
        current: () => this.currentMode(), list: () => this.modeChoices(),
        cycle: () => {
          const all = this.modeChoices()
          const base = this.baseMode && all.some(o => o.id === this.baseMode) ? this.baseMode : 'default'
          return all.filter(o => o.id === base || o.id === 'plan')
        },
        set: id => this.setOption('mode', id),
      }
    }
  }
  async applySavedPrefs(saved = this.prefs?.read(), rpc = this.rpc) {
    if (!saved || !rpc || !this.id) return
    // Apply model first because switching models can change available thought_level options.
    const desiredMode = saved.mode === FULL_ACCESS_MODE ? (this.option('mode')?.currentValue === 'plan' ? 'default' : undefined) : saved.mode
    for (const [id, value] of [['model', saved.model], ['thought_level', saved.effort], ['mode', desiredMode]]) {
      if (!value) continue
      const current = this.option(id)?.currentValue
      if (!this.option(id) || current === value) continue
      if (!this.choices(id).some(o => o.id === value)) continue
      try {
        const result = await rpc.request('session/set_config_option', { sessionId: this.id, configId: id, value }, deadline())
        if (result?.configOptions) this.configure(result.configOptions)
      } catch {}
    }
  }
  async setOption(id, value) {
    if (this.authHint) throw new Error(this.authHint)
    if (id === 'mode') {
      if (!this.modeChoices().some(o => o.id === value)) throw new Error('Unavailable Antigravity option')
      if (value === FULL_ACCESS_MODE) {
        if (this.skipPermissions) {
          if (this.option('mode')?.currentValue === 'plan') {
            const result = await this.rpc.request('session/set_config_option', { sessionId: this.id, configId: 'mode', value: 'default' }, deadline())
            this.configure(result.configOptions)
          }
        } else {
          if (this.status !== 'idle') throw new Error('请先结束当前回合再切换完全权限模式。')
          await this.reconnect(this.directories, false, { skipPermissions: true, mode: FULL_ACCESS_MODE })
        }
        this.baseMode = FULL_ACCESS_MODE
        this.prefs?.write({ mode: FULL_ACCESS_MODE })
        this.emit({ type: 'mode.changed', modeId: FULL_ACCESS_MODE })
        return
      }
      if (value !== 'plan' && this.skipPermissions) {
        if (this.status !== 'idle') throw new Error('请先结束当前回合再退出完全权限模式。')
        await this.reconnect(this.directories, false, { skipPermissions: false, mode: value })
        const actual = this.currentMode()
        if (actual && actual !== 'plan') {
          this.baseMode = actual
          this.prefs?.write({ mode: actual })
        }
        this.emit({ type: 'mode.changed', modeId: actual })
        return
      }
    } else if (!this.choices(id).some(o => o.id === value)) {
      throw new Error('Unavailable Antigravity option')
    }
    const result = await this.rpc.request('session/set_config_option', { sessionId: this.id, configId: id, value }, deadline())
    this.configure(result.configOptions)
    const actual = id === 'mode' ? this.currentMode() : this.option(id)?.currentValue
    if (id === 'model') {
      if (actual) this.prefs?.write({ model: actual })
      this.emit({ type: 'model.changed', model: actual, source: 'user' })
    }
    if (id === 'thought_level') {
      if (actual) this.prefs?.write({ effort: actual })
      this.emit({ type: 'effort.changed', effort: actual })
    }
    if (id === 'mode') {
      if (actual && actual !== 'plan') {
        this.baseMode = actual
        this.prefs?.write({ mode: actual })
      }
      this.emit({ type: 'mode.changed', modeId: actual })
    }
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
    this.emit({ type: 'pending.changed', items: [
      ...[...this.steered.values()].map(({ input }) => ({
        id: input.clientMessageId, text: input.text, placement: 'steer',
      })),
      ...this.queue.map(({ input }) => ({
        id: input.clientMessageId, text: input.text, placement: 'followup',
      })),
    ], ...change })
  }
  removePending(id) {
    const index = this.queue.findIndex(({ input }) => input.clientMessageId === id)
    if (index < 0) return false
    this.queue.splice(index, 1)
    this.pending({ discarded: [id] })
    return true
  }
  clearPending(key) {
    const ids = [...this.steered.keys(), ...this.queue.splice(0).map(({ input }) => input.clientMessageId)]
    this.steered.clear()
    if (ids.length) this.pending({ [key]: ids })
  }

  imageContext() {
    return { cwd: this.cwd, directories: this.directories, sessionId: this.id }
  }
  flush() {
    if (!this.blocks.length && !this.replyImages.length) return
    const seq = ++this.seq
    const text = this.blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const images = [...this.replyImages]
    const remaining = Math.max(0, 8 - images.length)
    if (remaining > 0) {
      images.push(...markdownImages(text, this.imageContext(), remaining, this.replyImagePaths))
    }
    this.emit({ type: 'assistant.message', seq, anchor: String(seq), turn: this.turn, step: this.step,
      attemptId: this.attempt, time: Date.now(), blocks: this.blocks, images: images.length ? images : undefined, canonical: true })
    this.emit({ type: 'assistant.attempt.end', attemptId: this.attempt, outcome: 'committed', turn: this.turn, step: this.step })
    this.blocks = []
    this.replyImages = []
    this.replyImagePaths = new Set()
  }
  user(text, id, blocks, images) {
    this.flush()
    this.turn++
    this.step = 0
    this.emit({ type: 'turn.start', turn: this.turn, origin: 'user', userMessageId: id, time: Date.now() })
    this.emit({ type: 'user.message', seq: ++this.seq, anchor: id, id, time: Date.now(), turn: this.turn, source: 'user', text, blocks, images })
  }
  flushReplayUser() {
    const message = this.replayUser
    if (!message) return
    this.replayUser = undefined
    const text = message.blocks.map(b => b.text).join('')
    this.user(text, message.id ?? 'replay-user-' + (this.turn + 1), message.blocks, message.images)
  }
  replayUserChunk(u) {
    if (this.replayUser && u.messageId && u.messageId !== this.replayUser.id) this.flushReplayUser()
    this.replayUser ??= { id: u.messageId, blocks: [], images: [] }
    const text = contentText(u.content)
    if (text) this.replayUser.blocks.push({ type: 'text', text })
    if (u.content.type === 'image') {
      const image = transcriptImage(u.content)
      if (image) this.replayUser.images.push(image)
    }
  }
  update(u) {
    if (this.status === 'disposed' || this.authHint) return
    const messageChunk = u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk'
    if (messageChunk || u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') this.flushReplayUser()
    if (messageChunk && u.messageId && u.messageId !== this.messageId) {
      this.flush()
      this.messageId = u.messageId
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const image = u.content?.type === 'image' ? transcriptImage(u.content) : undefined
        const linkedImage = u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'resource_link' && u.content.uri
          ? localTranscriptImage(u.content.uri, { ...this.imageContext(), name: u.content.name, seen: this.replyImagePaths }) : undefined
        const text = contentText(u.content)
        if (!image && !linkedImage && !text) return
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning'
        if (!this.blocks.length && !this.replyImages.length) {
          this.attempt = randomUUID()
          this.emit({ type: 'assistant.attempt.start', attemptId: this.attempt, turn: this.turn, step: ++this.step })
        }
        if (image) { this.replyImages.push(image); break }
        if (linkedImage && this.replyImages.length < 8) this.replyImages.push(linkedImage)
        if (!text) break
        if (this.blocks.at(-1)?.type !== kind) this.blocks.push({ type: kind, text: '' })
        this.blocks.at(-1).text += text
        this.emit({ type: 'assistant.delta', attemptId: this.attempt, index: this.blocks.length - 1, time: Date.now(),
          turn: this.turn, step: this.step, delta: { kind, text } })
        break
      }
      case 'user_message_chunk':
        if (this.status === 'starting' && u.content) this.replayUserChunk(u)
        break
      case 'tool_call':
      case 'tool_call_update': this.updateTool(u); break
      case 'available_commands_update': {
        const available = Array.isArray(u.availableCommands) ? u.availableCommands : []
        this.nativeCommands = available
        if (this.nativeCommands.some(c => c.name === 'compact')) {
          this.capabilities.compact = { run: async () => {
            const result = await this.submit({ text: '/compact', clientMessageId: randomUUID() })
            if (!result.accepted) throw new Error(result.reason)
            await this.active
          } }
        } else delete this.capabilities.compact
        const names = new Set(this.localCommands.map(c => c.name))
        this.commands = [...this.localCommands, ...available.filter(c => !names.has(c.name))]
        this.emit({ type: 'commands.changed', commands: this.commands })
        break
      }
      case 'config_option_update': this.configure(u.configOptions ?? []); break
      case 'session_info_update': if (u.title) this.emit({ type: 'session.title', title: u.title, source: 'auto' }); break
      case 'plan': this.emit({ type: 'todo.write', items: (u.entries ?? []).map(({ content, status }) => ({ content, status })) }); break
      case 'usage_update':
        // agy publishes timer and background-agent replies after the initiating
        // prompt resolves. Their usage update closes a message, without a
        // second session/prompt response or a new user turn.
        if (this.status === 'idle') this.flush()
        this.usage = { used: u.used, max: u.size, categories: [] }
        this.capabilities.context = { usage: async () => this.usage }
        this.emit({ type: 'context.usage', used: u.used, max: u.size })
        break
    }
  }

  updateTool(update) {
    this.flush()
    const callId = update.toolCallId
    const previous = this.tools.get(callId)
    if (previous?.status === 'completed' || previous?.status === 'failed') return
    // A final ACP update may contain only status. Retain the preceding
    // presentation and content until we can commit the complete result.
    const call = previous ?? { status: 'pending' }
    for (const key of ['name', 'kind', 'title', 'content', 'rawInput', 'rawOutput', 'status', 'locations']) {
      if (update[key] != null) call[key] = update[key]
    }
    this.tools.set(callId, call)
    if (!previous) {
      const info = toolCallPresentation(call, this.cwd)
      this.emit({ type: 'tool.call', seq: ++this.seq, turn: this.turn, step: this.step, callId,
        name: info.name, presentation: info.presentation, argsJson: JSON.stringify(call.rawInput ?? update.locations ?? {}), time: Date.now() })
    }
    if (!call.task) {
      const label = { schedule: '计时器', invoke_subagent: '后台智能体', run_workflow: '动态工作流' }[call.name ?? call.title?.replace(/^Run /, '')]
      if (typeof label === 'string') {
        const input = call.rawInput ?? {}
        const description = [input.Prompt, input.Description, input.TaskName, input.Instruction].find(v => typeof v === 'string') ?? ''
        call.task = { label, description }
        this.emit({ type: 'task.start', taskId: callId, callId, kind: call.name ?? call.title, description: description || label, background: true, time: Date.now() })
      }
    }
    if (call.status === 'completed' || call.status === 'failed') {
      const text = toolText(call)
      const isError = call.status === 'failed'
      const context = this.imageContext()
      const images = []
      const seenPaths = new Set()
      for (const item of call.content ?? []) {
        if (item.type !== 'content') continue
        if (item.content?.type === 'image') {
          const img = transcriptImage(item.content)
          if (img) images.push(img)
        } else if (item.content?.type === 'resource_link' && item.content.uri) {
          const img = localTranscriptImage(item.content.uri, { ...context, name: item.content.name, seen: seenPaths })
          if (img) images.push(img)
        }
      }
      if (!isError && !images.length && (call.kind === 'read' || /^(?:read_file|view_file)$/i.test(call.name ?? ''))) {
        const rawPath = toolPath(call)
        const img = rawPath ? localTranscriptImage(rawPath, context) : undefined
        if (img) images.push(img)
      }
      this.emit({ type: 'tool.result', seq: ++this.seq, turn: this.turn, step: this.step, callId, time: Date.now(),
        isError, ...(isError ? { errorText: text || 'Tool failed' } : {}),
        presentation: toolResultPresentation(call, text, this.cwd), text, content: [{ type: 'text', text }], images: images.length ? images : undefined })
      if (call.task) this.emit({ type: 'task.end', taskId: callId, status: call.status, time: Date.now() })
      this.tools.set(callId, { status: call.status, task: call.task })
    } else {
      const text = toolText(update)
      if (text) this.emit({ type: 'tool.output', callId, text, time: Date.now() })
    }
  }

  permission({ sessionId, toolCall, options }, signal) {
    if (this.authHint || sessionId !== this.id || this.status === 'disposed' || this.cancelling || signal?.aborted) return cancelled()
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
    if (!this.permissions.size && this.status === 'requires-action') {
      this.setStatus(this.active ? 'running' : 'idle')
    }
  }
  dismiss() { for (const id of this.permissions.keys()) this.respond(id) }

  async submit(input, placement = 'turn') {
    if (this.status === 'disposed') return { accepted: false, dropped: true, reason: 'Antigravity 会话已关闭。' }
    if (this.localAction) return { accepted: false, dropped: true, reason: '请先完成或关闭当前面板。' }
    let text = input.text.trim()
    const rawName = text.replace(/^\/agy\s+/, '/').slice(1)
    const page = /^([a-z]+)\s+page\s+(\d+)$/.exec(rawName)
    if (text.startsWith('/') && page && Object.hasOwn(reportLabels, page[1]) && !interactiveReports.has(page[1])) {
      this.pending({ claimed: [input.clientMessageId] })
      this.printPage(page[1], Number(page[2]))
      return { accepted: true }
    }
    const quotaCommand = /^(usage|quota)(?:\s+(refresh))?$/.exec(rawName)
    const name = quotaCommand?.[1] ?? rawName
    if (text.startsWith('/') && !quotaCommand && /^(usage|quota)\s/.test(rawName)) {
      return { accepted: false, dropped: true, reason: '请使用 /usage 或 /usage refresh。' }
    }
    const search = /^\/(?:agy\s+)?(?:codesearch|cs)(?:\s+([\s\S]*))?$/.exec(text)
    const panel = search ? 'codesearch' : name
    const localPanel = search || text === '/artifacts' || (text.startsWith('/agy ') && Object.hasOwn(actionLabels, panel))
    const signIn = text === '/agy login' || text === '/signin'
    if (this.status !== 'idle' && text.startsWith('/') &&
        (localPanel || signIn || text === '/agy' || Object.hasOwn(reportLabels, name))) {
      return { accepted: false, dropped: true, reason: '请先结束当前回合，再打开 Antigravity 面板。' }
    }
    if (signIn) {
      this.pending({ claimed: [input.clientMessageId] })
      void this.login()
      return { accepted: true }
    }
    if (text === '/agy') {
      this.pending({ claimed: [input.clientMessageId] })
      this.localAction = new AbortController()
      void this.showMenu(this.localAction)
      return { accepted: true }
    }
    if (text.startsWith('/') && Object.hasOwn(reportLabels, name)) {
      this.pending({ claimed: [input.clientMessageId] })
      if (interactiveReports.has(name)) {
        this.localAction = new AbortController()
        void this.showReport(name, this.localAction)
      } else void this.printReport(name, Boolean(quotaCommand?.[2]))
      return { accepted: true }
    }
    if (localPanel) {
      this.pending({ claimed: [input.clientMessageId] })
      const action = new AbortController()
      this.localAction = action
      void this.showAction(panel, action, search?.[1]).catch(error => {
        if (!action.signal.aborted) this.emit({ type: 'notice', level: 'error', text: error.message })
      }).finally(() => { this.localAction = undefined })
      return { accepted: true }
    }
    if (this.authHint) return { accepted: false, dropped: true, reason: this.authHint }
    if (/^\/agy\s/.test(text)) {
      const command = name.split(/\s+/, 1)[0]
      const modeSwitch = /^plan(?:\s+(?:on|off))?$/.test(name) && this.capabilities.modes
      if (!modeSwitch && !this.nativeCommands.some(c => c.name === command)) return { accepted: false, dropped: true, reason: '当前 agy 未提供此命令。输入 /agy 查看可用面板。' }
      text = '/' + name
      const blocks = input.blocks?.slice()
      const first = blocks?.findIndex(b => b.type === 'text') ?? -1
      if (first >= 0) blocks[first] = { ...blocks[first], text: blocks[first].text.replace(/^\s*\/agy\s+/, '/') }
      input = { ...input, text, blocks }
    }
    // Task-bearing /plan (including stacked commands) is expanded by agy.
    if (/^\/plan(?:\s+(?:on|off))?$/.test(text) && this.capabilities.modes) {
      if (this.status !== 'idle') return { accepted: false, dropped: true, reason: '请先结束当前回合再切换模式。' }
      const argument = text.slice(5).trim()
      const fallback = this.baseMode && this.modeChoices().some(o => o.id === this.baseMode) ? this.baseMode : 'default'
      await this.setOption('mode', argument === 'off' ? fallback : 'plan')
      this.pending({ claimed: [input.clientMessageId] })
      return { accepted: true }
    }
    if (this.status === 'running' && placement === 'steer' && this.acceptSteers && !this.cancelling) {
      const id = input.clientMessageId
      this.steered.set(id, { input })
      this.pending({})
      const steered = this.steer(input)
      this.steers.add(steered)
      void steered.finally(() => this.steers.delete(steered))
      return { accepted: true }
    }
    if (this.active && this.status !== 'idle' && this.status !== 'disposed') {
      if (placement === 'now') {
        this.queue.unshift({ input })
        this.pending({})
        if (!this.cancelling) void this.cancel('user')
        return { accepted: true }
      }
      if (placement === 'followup' || placement === 'steer') {
        this.queue.push({ input })
        this.pending({})
        return { accepted: true }
      }
    }
    if (this.status !== 'idle') return { accepted: false, dropped: true, reason: 'Antigravity session is busy or disconnected.' }
    this.setStatus('running')
    this.active = this.run(input)
    return { accepted: true }
  }
  async steer(input) {
    const id = input.clientMessageId
    const blocks = input.blocks ?? [{ type: 'text', text: input.text }]
    try {
      const prompt = await this.promptBlocks(blocks, input.images)
      if (!this.steered.has(id)) return
      if (this.cancelling || this.disposing) {
        this.steered.delete(id)
        if (!this.disposing) {
          if (this.cancelCause === 'user') {
            this.queue.push({ input })
            this.pending({})
          } else this.pending({ discarded: [id] })
        }
        return
      }
      const result = await this.rpc.request('session/prompt', { sessionId: this.id, prompt })
      if (!this.steered.delete(id)) return
      if (result?.stopReason === 'cancelled') {
        if (this.cancelCause === 'user') {
          this.queue.push({ input })
          this.pending({})
        } else this.pending({ discarded: [id] })
        return
      }
      this.pending({ claimed: [id] })
      this.emit({ type: 'user.message', seq: ++this.seq, anchor: id, id,
        time: Date.now(), turn: this.turn, source: 'user', text: input.text, blocks, images: input.images })
    } catch {
      if (!this.steered.delete(id)) return
      if (this.disposing) return
      if (this.cancelling) {
        if (this.cancelCause === 'user') {
          this.queue.push({ input })
          this.pending({})
        } else this.pending({ discarded: [id] })
        return
      }
      this.queue.push({ input })
      this.pending({})
      this.emit({ type: 'notice', level: 'info', text: '当前步骤未能立即插入引导，消息已排入下一回合队列。' })
    }
  }

  async promptBlocks(blocks, images) {
    const prompt = blocks.filter(b => b.type === 'text').map(b => ({ type: 'text', text: b.text }))
    for (const image of images ?? []) prompt.push({ type: 'image', mimeType: image.mediaType ?? 'image/png', data: Buffer.from(await image.read()).toString('base64') })
    return prompt
  }
  async settleSteers() {
    if (this.steered.size > 0 && this.steers.size > 0) {
      let timer
      try {
        await Promise.race([
          Promise.allSettled(this.steers),
          new Promise(resolve => { timer = setTimeout(resolve, this.cancelling ? 250 : 1500) }),
        ])
      } finally { clearTimeout(timer) }
    }
    if (!this.steered.size) return
    const leftover = [...this.steered.values()]
    this.steered.clear()
    if (this.disposing) return
    if (this.cancelling) {
      if (this.cancelCause === 'user') {
        this.queue.unshift(...leftover.map(({ input }) => ({ input })))
        this.pending({})
      } else {
        this.pending({ discarded: leftover.map(({ input }) => input.clientMessageId) })
      }
    } else {
      this.pending({ dropped: leftover.map(({ input }) => input.clientMessageId) })
    }
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
    } catch (e) {
      if (e.code === -32000 || /unauthenticated|authentication required/i.test(e.message)) {
        this.authHint = 'agy 需要重新授权。请运行 /login，然后继续会话。'
        this.clearPending('dropped')
        reason = { kind: 'error', message: this.authHint }
      } else reason = { kind: 'error', message: e.message }
    }
    finally {
      this.acceptSteers = false
      await this.settleSteers()
      this.flush()
      this.dismiss()
      this.emit({ type: 'turn.end', turn: this.turn, time: Date.now(), reason, usage })
      this.cancelling = false
      this.cancelCause = undefined
      this.active = undefined
      if (this.status !== 'disposed' && !this.disposing) {
        this.setStatus('idle')
        const next = this.queue.shift()
        if (next) void this.submit(next.input)
      }
    }
  }
  async cancel(cause) {
    for (const query of this.reportQueries.values()) query.abort()
    this.localAction?.abort()
    this.panels.close()
    if (cause !== 'user') this.clearPending('discarded')
    const remaining = () => [...this.steered.keys(), ...this.queue.map(({ input }) => input.clientMessageId)]
    if (this.status === 'disposed') return { stillQueued: remaining(), outcome: 'unknown' }
    if (this.status === 'idle') return { stillQueued: [], outcome: 'confirmed' }
    if (!this.active) {
      this.dismiss()
      try { await this.rpc?.notify('session/cancel', { sessionId: this.id }) } catch {}
      return { stillQueued: remaining(), outcome: 'unknown' }
    }
    const active = this.active
    this.cancelling = true
    this.cancelCause = cause
    this.dismiss()
    try { await this.rpc?.notify('session/cancel', { sessionId: this.id }) } catch {}
    let timer
    try {
      const done = await Promise.race([active.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
      return { stillQueued: remaining(), outcome: done ? 'confirmed' : 'unknown' }
    } finally { clearTimeout(timer) }
  }
  async dispose() {
    this.disposing = true
    this.clearReports()
    this.localAction?.abort()
    this.panels.close()
    this.setStatus('disposed')
    this.clearPending('dropped')
    this.dismiss()
    await this.rpc?.close()
    this.listeners.clear()
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
}

function singleLine(text) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  const lines = trimmed.split(/\r?\n/u)
  const first = lines[0].trimEnd()
  return lines.length > 1 ? first + ' …' : first
}

// Tool input can contain literal filesystem paths, unlike agy's encoded catalog.
function toolDisplayPath(path) {
  return existsSync(path) ? path : normalizeWorkspaceCwd(path)
}

function displayPath(path, cwd) {
  if (!path) return ''
  const normalized = toolDisplayPath(path)
  if (!isAbsolute(normalized) || !cwd) return normalized
  const rel = relative(cwd, normalized)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? normalized : rel
}

function toolDiffs(u) {
  return (u.content ?? []).filter(c => c.type === 'diff').map(c =>
    ({ path: c.path, oldText: c.oldText ?? null, newText: c.newText }))
}

function toolPath(u) {
  const input = u.rawInput ?? {}
  return firstString(input.Path, input.path, input.file_path, input.TargetFile, u.locations?.[0]?.path)
}

function shortToolName(u) {
  const raw = firstString(u.name, u.kind)
  if (raw) return raw.slice(0, 32)
  return 'tool'
}

function toolCallPresentation(u, cwd) {
  const diffs = toolDiffs(u)
  if (diffs.length) {
    const allNew = diffs.every(d => d.oldText == null || d.oldText === '')
    const name = allNew ? 'write' : 'edit'
    const paths = diffs.map(d => displayPath(d.path, cwd)).filter(Boolean).join(', ')
    const title = (allNew ? 'Write ' : 'Edit ') + (paths || singleLine(u.title))
    return { name, presentation: { card: 'diff', diffs, title: title.trim(), displayKey: allNew ? 'tool-name-write' : 'tool-name-edit', category: 'mutate' } }
  }
  const input = u.rawInput ?? {}
  if (u.kind === 'execute' || /^(?:run_command|bash|shell)$/i.test(u.name ?? '')) {
    const cmd = firstString(input.CommandLine, input.command, input.cmd, u.title) || 'Terminal'
    return { name: 'bash', presentation: { card: 'terminal', title: singleLine(cmd), displayKey: 'tool-name-bash', category: 'exec' } }
  }
  if (u.kind === 'read' || /^(?:read_file|view_file)$/i.test(u.name ?? '')) {
    const rawPath = toolPath(u)
    const stripped = singleLine(u.title).replace(/^(?:file|read|view)\s+/iu, '')
    const shown = rawPath ? displayPath(rawPath, cwd) : stripped
    const title = shown ? 'Read ' + shown : singleLine(u.title) || 'Read'
    return { name: 'read', presentation: { card: 'generic', title, ...(rawPath ? { path: toolDisplayPath(rawPath) } : {}), displayKey: 'tool-name-read', category: 'other' } }
  }
  if (u.kind === 'search') {
    const toolName = /web/i.test(u.name ?? '') ? 'web_search' : /glob|find/i.test(u.name ?? '') ? 'glob' : 'grep'
    const displayKey = 'tool-name-' + toolName
    const query = firstString(input.query, input.Query, input.pattern, input.Pattern)
    const title = singleLine(u.title) || (query ? `${toolName} ${query}` : toolName)
    return { name: toolName, presentation: { card: 'generic', title, displayKey, category: 'other' } }
  }
  if (u.kind === 'edit' || u.kind === 'delete' || u.kind === 'move') {
    const rawPath = toolPath(u)
    const label = u.kind === 'edit' ? 'Edit' : u.kind === 'delete' ? 'Delete' : 'Move'
    const title = singleLine(u.title) || (rawPath ? `${label} ${displayPath(rawPath, cwd)}` : label)
    return { name: u.kind, presentation: { card: 'generic', title, ...(rawPath ? { path: toolDisplayPath(rawPath) } : {}), ...(u.kind === 'edit' ? { displayKey: 'tool-name-edit' } : {}), category: 'mutate' } }
  }
  const name = shortToolName(u)
  const title = singleLine(u.title) || name
  return { name, presentation: { card: 'generic', title, category: 'other' } }
}

function toolResultPresentation(u, text, cwd) {
  const diffs = toolDiffs(u)
  if (diffs.length) {
    const allNew = diffs.every(d => d.oldText == null || d.oldText === '')
    const paths = diffs.map(d => displayPath(d.path, cwd)).filter(Boolean).join(', ')
    const title = (allNew ? 'Write ' : 'Edit ') + (paths || singleLine(u.title))
    return { card: 'diff', diffs, title: title.trim(), displayKey: allNew ? 'tool-name-write' : 'tool-name-edit', category: 'mutate' }
  }
  if (u.kind === 'execute' || /^(?:run_command|bash|shell)$/i.test(u.name ?? '')) {
    return { card: 'terminal', output: text, displayKey: 'tool-name-bash', category: 'exec' }
  }
  if (u.kind === 'read' || /^(?:read_file|view_file)$/i.test(u.name ?? '')) {
    const rawPath = toolPath(u)
    const stripped = singleLine(u.title).replace(/^(?:file|read|view)\s+/iu, '')
    const shown = rawPath ? displayPath(rawPath, cwd) : stripped
    const title = shown ? 'Read ' + shown : singleLine(u.title) || 'Read'
    return { card: 'read', title, ...(rawPath ? { path: toolDisplayPath(rawPath) } : {}), content: text ? [{ type: 'text', text }] : [], displayKey: 'tool-name-read', category: 'other' }
  }
  return toolCallPresentation(u, cwd).presentation
}

// Keep native references visible without fetching linked files or URLs.
function contentText(content) {
  if (content?.type === 'text') return content.text
  if (content?.type === 'resource_link') return [content.name, content.uri].filter(Boolean).join(' · ')
  if (content?.type === 'resource') return [content.resource?.uri, content.resource?.text].filter(Boolean).join('\n')
}

function toolText(u) {
  const text = (u.content ?? []).map(c => c.type === 'diff'
    ? [c.path, '---', c.oldText, '+++', c.newText].join('\n')
    : contentText(c.content)).filter(Boolean).join('\n')
  if (text || (u.content ?? []).some(c => c.content?.type === 'image')) return text
  return u.rawOutput == null ? '' : JSON.stringify(u.rawOutput)
}

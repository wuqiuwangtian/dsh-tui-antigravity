// A resume target already holds the host's session lock while the user chooses a directory.
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Panels } from './panels.js'

export function chooseWorkspace(id, original, base, load) {
  let session, pending, disposed = false
  const listeners = new Set()
  const send = (events, delivery) => { for (const listener of listeners) listener(events, delivery) }
  const panels = new Panels(event => send([event], { replay: false }))
  const hint = '输入 /workspace 重新选择工作区，或用 /new 新建对话。'
  const capabilities = { native: {}, questions: panels.questions,
    commands: { list: async () => [{ name: 'workspace', description: '为此旧会话选择工作区' }] } }
  async function choose() {
    try {
      const selection = await panels.ask([{ header: '恢复 Antigravity 会话', question: '原工作区不可用，请选择如何继续',
        detail: '原目录：' + (original || '未知') + '\n当前目录：' + base,
        options: [{ label: '取消' }, { label: '使用当前目录' }, { label: '输入其他目录' }], hideCustomInput: true }])
      const choice = selection?.[0]?.selected?.[0]
      if (!['使用当前目录', '输入其他目录'].includes(choice)) return
      let dir = base
      if (choice === '输入其他目录') {
        const entry = await panels.ask([{ header: '工作区', question: '输入新的目录路径', options: [] }])
        const path = entry?.[0]?.custom?.trim()
        if (!path) return
        dir = resolve(base, path)
      }
      dir = await realpath(dir)
      if (!(await stat(dir)).isDirectory()) throw Error('请选择一个目录。')
      if (disposed) return
      const confirm = await panels.ask([{ header: '恢复会话', question: '在此目录恢复历史并运行工具？', detail: dir,
        options: [{ label: '取消' }, { label: '确认恢复' }], hideCustomInput: true }])
      if (disposed || confirm?.[0]?.selected?.[0] !== '确认恢复') return
      const opened = await load(dir)
      if (disposed) { await opened.dispose(); return }
      session = opened
      Object.assign(capabilities, session.capabilities)
      session.subscribe(send)
      send(await session.history(), { replay: true })
    } catch (error) {
      if (!disposed) send([{ type: 'notice', level: 'error', text: error.message }], { replay: false })
    } finally {
      pending = undefined
      if (!disposed && !session) send([{ type: 'notice', level: 'info', text: hint }], { replay: false })
    }
  }
  let first = true
  return {
    ref: { backendId: 'antigravity', sessionId: id }, capabilities,
    get cwd() { return session?.cwd ?? base },
    get status() { return disposed ? 'disposed' : session?.status ?? 'idle' },
    history: async () => session ? session.history() : [],
    subscribe(listener) {
      listeners.add(listener)
      if (first) { first = false; queueMicrotask(() => { if (!disposed && !pending) pending = choose() }) }
      return () => listeners.delete(listener)
    },
    async submit(input, placement) {
      if (session) return session.submit(input, placement)
      if (!disposed && !pending && input.text?.trim() === '/workspace') {
        pending = choose()
        return { accepted: true }
      }
      return { accepted: false, dropped: true, reason: hint }
    },
    async cancel(cause) {
      if (session) return session.cancel(cause)
      panels.close()
      return { outcome: 'confirmed', stillQueued: [] }
    },
    async dispose() { disposed = true; panels.close(); listeners.clear(); await pending; await session?.dispose() },
  }
}

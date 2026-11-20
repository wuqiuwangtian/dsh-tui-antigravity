import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { executable } from './connection.js'
import { mcpControl } from './mcp.js'

const run = promisify(execFile)
const choose = async (panels, signal, question, options, detail) => {
  const answers = await panels.ask([{ header: 'Antigravity', question, detail,
    options: options.map(label => ({ label })), hideCustomInput: true }], signal)
  return answers?.[0]?.selected?.[0]
}
async function input(panels, signal, question, detail) {
  const answers = await panels.ask([{ header: 'Antigravity', question, detail, options: [] }], signal)
  return answers?.[0]?.custom?.trim()
}

export const managers = {
  plugins: '管理原生插件',
  mcp: '管理原生 MCP 服务',
  remote: '查看和控制本机远程服务',
}

async function remoteControl(cwd, panels, signal) {
  const call = (...args) => run(executable(), ['remote-control', ...args], { cwd, signal, timeout: 45000 })
  while (!signal.aborted) {
    const { stdout, stderr } = await call('status')
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    const selected = await choose(panels, signal, 'Antigravity Remote Control', ['关闭', '刷新', '启动至本次系统登录结束', '停止并注销设备'], detail)
    if (!selected || selected === '关闭') return
    if (selected === '刷新') continue
    const start = selected === '启动至本次系统登录结束'
    const args = start ? ['start', '--session'] : ['stop']
    const confirm = await choose(panels, signal, start ? '向 Google 注册本机并启动远程控制服务？' : '停止远程控制并注销此设备？',
      ['返回', '确认'], 'agy remote-control ' + args.join(' '))
    if (confirm === '确认') await call(...args)
  }
}

export async function manage(kind, cwd, panels, signal) {
  if (kind === 'remote') return remoteControl(cwd, panels, signal)
  const plugins = kind === 'plugins'
  const noun = plugins ? '插件' : 'MCP 服务'
  const add = plugins ? '安装插件' : '添加 MCP 服务'
  const group = plugins ? 'plugin' : 'mcp'
  const call = (...args) => run(executable(), [group, ...args], { cwd, signal, timeout: 60000, maxBuffer: 1024 * 1024 })
  while (!signal.aborted) {
    const rows = plugins ? JSON.parse((await call('list', '--json')).stdout).map(p => ({ name: p.name, enabled: p.enabled })) :
      (await mcpControl(cwd).status()).map(p => ({ name: p.name, enabled: p.status === 'enabled' }))
    const labels = rows.map(row => (row.enabled ? '已启用 · ' : '已停用 · ') + row.name)
    const selected = await choose(panels, signal, noun + '管理', ['关闭', add, ...labels])
    if (!selected || selected === '关闭') return
    const row = rows[labels.indexOf(selected)]
    let args
    if (selected === add) {
      const name = await input(panels, signal, plugins ? '插件安装来源' : '服务名称',
        plugins ? '本地插件路径或 agy 支持的安装标识。' : '添加基本 stdio 或 HTTP 服务。')
      if (!name) continue
      if (name.startsWith('-') || /[\r\n]/.test(name)) throw new Error('无效名称或安装来源。')
      if (plugins) args = ['install', name]
      else {
        const target = await input(panels, signal, '服务 URL 或可执行文件路径')
        if (!target || target.startsWith('-')) continue
        let argv = []
        if (!/^https?:\/\//i.test(target)) {
          const raw = await input(panels, signal, '命令参数', '输入 JSON 字符串数组，例如 []。')
          if (!raw) continue
          argv = JSON.parse(raw)
          if (!Array.isArray(argv) || !argv.every(v => typeof v === 'string')) throw new Error('参数须为字符串数组。')
        }
        args = ['add', name, '--', target, ...argv]
      }
    } else if (row && !row.name.startsWith('-')) {
      const toggle = row.enabled ? '停用' : '启用'
      const selectedAction = await choose(panels, signal, row.name, ['返回', toggle, '移除'])
      if (!selectedAction || selectedAction === '返回') continue
      args = [selectedAction === '移除' ? (plugins ? 'uninstall' : 'remove') : (row.enabled ? 'disable' : 'enable'), row.name]
    } else continue
    const confirm = await choose(panels, signal, '应用原生配置变更？', ['返回', '确认'], 'agy ' + group + ' ' + args.map(a => JSON.stringify(a)).join(' '))
    if (confirm !== '确认') continue
    await call(...args)
  }
}

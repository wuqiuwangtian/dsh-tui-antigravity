import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { settings } from './settings.js'
import { executable } from './connection.js'

export const reports = {
  usage: '模型组配额和重置时间',
  quota: '查看模型配额',
  credits: '查看 Antigravity 积分',
  agents: '查看已配置的智能体',
  hooks: '查看 Antigravity Hooks',
  skills: '查看 Antigravity 技能',
  config: '查看生效的 Antigravity 配置',
  permissions: '查看各作用域的权限规则',
  changelog: '查看 Antigravity 版本记录',
}

// agy emits its terminal result before it finishes process cleanup. Keep draining
// stdout and let the child exit normally after the validated response is ready.
function queryReport(command, cwd, signal) {
  return new Promise((resolve, reject) => {
    let report
    const child = execFile(executable(), ['--settings', '{"disableSlashCommands":false}', '--output-format', 'stream-json', '--print-timeout', '20s', '-p', '/' + command],
      { cwd, signal, timeout: 25000, maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error && command === 'credits' && stderr.includes('no credits info found')) resolve({})
        else reject(new Error(error ? '官方 CLI 查询失败，请检查登录和网络后重试。' : '当前 agy 未返回本地命令结果。'))
      })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      if (!line.trim()) return
      let record
      try { record = JSON.parse(line) } catch { reject(new Error('无法解析官方 CLI 的命令结果。')); return }
      if (record?.event === 'command_result' && record.command?.name === command) report = record
      if (record?.event === 'result' && report && record.result?.status === 'SUCCESS' && record.result.num_turns === 0) {
        resolve({ report, result: record.result })
      }
    })
  })
}

export async function readReport(name, cwd, signal) {
  if (!Object.hasOwn(reports, name)) throw new Error('Unknown report')
  const command = name === 'quota' ? 'usage' : name
  const { report, result } = await queryReport(command, cwd, signal)
  if (!report) return { text: '当前账号未提供积分信息。' }
  if (command === 'usage' && Array.isArray(report.command.data?.groups)) {
    const lines = []
    const windows = []
    for (const group of report.command.data.groups) {
      lines.push(group.name)
      for (const b of group.buckets ?? []) {
        const fraction = b.remaining_fraction
        const reset = Date.parse(b.reset_time)
        const remaining = Number.isFinite(fraction) ? Math.round(fraction * 100) + '%' : '未知'
        lines.push('  ' + b.name + ' · 剩余 ' + remaining + (Number.isFinite(reset) ? ' · ' + new Date(reset).toLocaleString() + ' 重置' : ''))
        if (Number.isFinite(fraction)) windows.push({ name: group.name + ' · ' + b.name, utilization: 1 - fraction, resetsAt: Number.isFinite(reset) ? reset : undefined })
      }
    }
    if (lines.length) return { text: lines.join('\n'), windows }
  }
  const data = report.command.data ?? {}
  if (name === 'config') {
    const config = data.config
    if (!config || typeof config !== 'object') return { text: '当前 agy 未提供结构化配置。' }
    return { text: [...settings.keys()].map(key => key + ' · ' + (JSON.stringify(config[key]) ?? '未提供')).join('\n') }
  }
  if (name === 'agents' && Array.isArray(data.agents)) {
    const agents = data.agents.filter(a => typeof a === 'string' && a && !a.startsWith('-'))
    return { text: agents.join('\n') || '当前工作区没有可选的自定义智能体。', agents }
  }
  if (name === 'permissions' && !result.response?.trim() && Array.isArray(data.permissions)) {
    return { text: data.permissions.map(p => Object.keys(p).length === 1 ? p.scope + ' · 无显式规则' : JSON.stringify(p)).join('\n') }
  }
  if (name === 'hooks' && Array.isArray(data.hooks) && !data.hooks.length) return { text: '当前没有配置 Hooks。' }
  return { text: result.response?.trim() || '官方 CLI 未返回内容。' }
}

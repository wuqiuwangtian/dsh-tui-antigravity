import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { executable } from './connection.js'

const run = promisify(execFile)
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

export async function readReport(name, cwd, signal) {
  if (!Object.hasOwn(reports, name)) throw new Error('Unknown report')
  const command = name === 'quota' ? 'usage' : name
  let stdout
  try {
    const result = await run(executable(), ['--output-format', 'stream-json', '--print-timeout', '20s', '-p', '/' + command],
      { cwd, signal, timeout: 25000, maxBuffer: 2 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    if (name === 'credits' && error.stderr?.includes('no credits info found')) return { text: '当前账号未提供积分信息。' }
    throw new Error('官方 CLI 查询失败，请检查登录和网络后重试。')
  }
  const records = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const report = records.find(r => r.event === 'command_result' && r.command?.name === command)
  const result = records.find(r => r.event === 'result')?.result
  if (!report || result?.status !== 'SUCCESS' || result.num_turns !== 0) throw new Error('当前 agy 未返回本地命令结果。')
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
  return { text: result.response?.trim() || '官方 CLI 未返回内容。' }
}

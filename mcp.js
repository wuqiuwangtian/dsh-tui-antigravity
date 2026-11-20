import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { executable } from './connection.js'

const run = promisify(execFile)
export function mcpControl(cwd) {
  const call = (...args) => run(executable(), ['mcp', ...args], { cwd, timeout: 10000, maxBuffer: 1024 * 1024 })
  async function status() {
    const { stdout } = await call('list')
    if (stdout.trim() === 'No MCP servers configured.') return []
    const [header, ...lines] = stdout.trimEnd().split(/\r?\n/)
    const typeAt = header.indexOf('TYPE')
    const statusAt = header.indexOf('STATUS')
    const commandAt = header.indexOf('COMMAND/URL')
    if (!header.startsWith('NAME') || typeAt < 1 || statusAt <= typeAt || commandAt <= statusAt)
      throw new Error('无法识别 agy mcp list 的输出。')
    return lines.filter(line => line.trim()).map(line => ({
      name: line.slice(0, typeAt).trim(), status: line.slice(statusAt, commandAt).trim(),
    }))
  }
  return { status, async toggle(name, enabled) {
    if (name.startsWith('-') || !(await status()).some(row => row.name === name)) throw new Error('未知 MCP 服务。')
    await call(enabled ? 'enable' : 'disable', name)
  } }
}

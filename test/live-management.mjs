// Exercises configuration writes against the official local CLI, in a temporary home.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { executable } from '../connection.js'
import { manage } from '../management.js'
import { mcpControl } from '../mcp.js'

const temp = await mkdtemp(join(tmpdir(), 'agy-management-'))
const originalHome = process.env.HOME
process.env.HOME = temp
const plugin = join(temp, 'plugin')
async function select(kind, steps) {
  const answers = [...steps, '关闭']
  const panels = { async ask([question]) {
    const entry = answers.shift()
    assert.ok(entry)
    if (!question.options.length) return [{ custom: entry, selected: [] }]
    assert.ok(question.options.some(o => o.label === entry), entry)
    return [{ selected: [entry] }]
  } }
  await manage(kind, temp, panels, new AbortController().signal)
  assert.equal(answers.length, 0)
}
try {
  const mcp = mcpControl(temp)
  await select('mcp', ['添加 MCP 服务', 'example', '/usr/bin/true', '[]', '确认'])
  assert.deepEqual(await mcp.status(), [{ name: 'example', status: 'enabled' }])
  await select('mcp', ['已启用 · example', '停用', '确认'])
  assert.equal((await mcp.status())[0].status, 'disabled')
  await select('mcp', ['已停用 · example', '移除', '确认'])
  assert.deepEqual(await mcp.status(), [])
  await mkdir(plugin)
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name: 'local-test', version: '1.0.0', description: 'Test' }))
  const installed = () => JSON.parse(execFileSync(executable(), ['plugin', 'list', '--json'], { cwd: temp, encoding: 'utf8' }))
  await select('plugins', ['安装插件', plugin, '确认'])
  assert.equal(installed()[0].name, 'local-test')
  await select('plugins', ['已启用 · local-test', '停用', '确认'])
  assert.equal(installed()[0].enabled, false)
  await select('plugins', ['已停用 · local-test', '移除', '确认'])
  assert.deepEqual(installed(), [])
  console.log('PASS: native MCP and plugin configuration writes isolated to temporary home')
} finally {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(temp, { recursive: true, force: true })
}

// Uses an authenticated agy to read a temporary overlay in zero model turns.
// The editor sees an isolated HOME. The real account's settings are never edited.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { executable } from '../connection.js'
import { editSetting } from '../settings.js'

const originalHome = process.env.HOME
const home = await mkdtemp(join(tmpdir(), 'agy-config-check-'))
const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
const rule = 'read_file(example-test-scope/)'
const signal = new AbortController().signal
function steps(...answers) {
  return { ask: async ([q]) => {
    const value = answers.shift()
    if (!q.options.length) return [{ selected: [], custom: value }]
    assert.ok(q.options.some(o => o.label === value))
    return [{ selected: [value] }]
  } }
}
function restoreHome() {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
}
try {
  process.env.HOME = home
  assert.ok(await editSetting(steps('agentMode', '"plan"', '确认写入'), signal, false))
  assert.ok(await editSetting(steps('ask', '添加规则', rule, '确认写入'), signal, true))
  restoreHome()
  for (const cmd of ['config', 'permissions']) {
    const { stdout } = await promisify(execFile)(executable(), ['--settings', file, '--output-format', 'stream-json',
      '--print-timeout', '20s', '-p', '/' + cmd], { cwd: home, timeout: 25000 })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line))
    const result = events.find(e => e.event === 'result').result
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.num_turns, 0)
    const { data } = events.find(e => e.event === 'command_result' && e.command.name === cmd).command
    if (cmd === 'config') assert.equal(data.config.agentMode, 'plan')
    else assert.ok(JSON.stringify(data.permissions).includes(rule))
  }
  console.log('PASS: native agy reads the confirmed mode and permission rule from the temporary settings overlay')
} finally {
  restoreHome()
  await rm(home, { recursive: true, force: true })
}

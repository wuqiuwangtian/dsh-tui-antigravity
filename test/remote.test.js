import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manage } from '../management.js'

test('remote control reads status and requires an explicit confirmation for each change', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'agy-remote-'))
  const file = join(temp, 'calls')
  const previous = process.env.ANTIGRAVITY_EXECUTABLE
  process.env.ANTIGRAVITY_EXECUTABLE = fileURLToPath(new URL('./agent.mjs', import.meta.url))
  process.env.AGY_FIXTURE_REMOTE_LOG = file
  t.after(async () => {
    delete process.env.AGY_FIXTURE_REMOTE_LOG
    if (previous === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE
    else process.env.ANTIGRAVITY_EXECUTABLE = previous
    await rm(temp, { recursive: true, force: true })
  })
  const selections = ['启动至本次系统登录结束', '返回', '启动至本次系统登录结束', '确认', '停止并注销设备', '确认', '关闭']
  await manage('remote', temp, { async ask([q]) {
    const answer = selections.shift()
    assert.ok(q.options.some(o => o.label === answer))
    return [{ selected: [answer] }]
  } }, new AbortController().signal)
  assert.equal((await readFile(file, 'utf8')).trim(), ['status', 'status', 'start --session', 'status', 'stop', 'status'].join('\n'))
})

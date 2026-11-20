import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { viewTeam } from '../team.js'

test('team preview requires a native invocation and a reciprocal parent message; ignores arbitrary log paths and hidden model fields', async t => {
  const original = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'agy-team-'))
  process.env.HOME = home
  t.after(async () => {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
    await rm(home, { recursive: true, force: true })
  })
  const parent = randomUUID(), child = randomUUID(), foreign = randomUUID()
  const path = id => join(home, '.gemini/antigravity-cli/brain', id, '.system_generated/logs/transcript.jsonl')
  async function save(id, records) {
    await mkdir(dirname(path(id)), { recursive: true })
    await writeFile(path(id), records.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
  const created = (id, uri) => ({ type: 'GENERIC', source: 'MODEL', content: 'Created the following subagent:\n' +
    JSON.stringify({ conversationId: id, logAbsoluteUri: uri }) })
  await save(parent, [
    { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'invoke_subagent' }, { name: 'invoke_subagent' }] },
    created(foreign, 'file:///etc/passwd'), created(child, pathToFileURL(path(child)).href),
    created(foreign, pathToFileURL(path(foreign)).href),
  ])
  await save(child, [
    { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '\n<SYSTEM_MESSAGE>\n[Message] timestamp=test sender=' + parent + ' priority=HIGH content=Read left.' },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'public reply', thinking: 'hidden thought', tool_calls: [{ name: 'read_file' }] },
  ])
  await save(foreign, [{ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'unrelated message' }])
  const choices = [child, '返回列表', foreign, '返回列表', '关闭']
  await viewTeam(parent, { async ask([q]) {
    const choice = choices.shift()
    assert.ok(q.options.some(o => o.label === choice))
    if (q.question.startsWith(child)) {
      assert.match(q.detail, /工具 · read_file\npublic reply/)
      assert.ok(!q.detail.includes('hidden thought'))
    }
    if (q.question.startsWith(foreign)) {
      assert.match(q.detail, /尚未确认/)
      assert.ok(!q.detail.includes('unrelated message'))
    }
    return [{ selected: [choice] }]
  } }, new AbortController().signal)
  assert.equal(choices.length, 0)
})

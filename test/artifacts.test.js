import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { viewArtifacts } from '../artifacts.js'

test('previews native Markdown in the current conversation and excludes internal files and symbolic links', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agy-artifacts-'))
  const original = process.env.HOME
  process.env.HOME = home
  t.after(async () => {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
    await rm(home, { recursive: true, force: true })
  })
  const parent = join(home, '.gemini', 'antigravity-cli', 'brain')
  const dir = join(parent, 'example-id')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'implementation_plan.md'), '# Test plan\nNext step')
  await writeFile(join(dir, '.hidden.md'), 'hidden')
  await symlink(join(dir, '.hidden.md'), join(dir, 'link.md'))
  const selections = ['implementation_plan.md', '返回列表', '关闭']
  await viewArtifacts('example-id', { async ask([q]) {
    assert.ok(q.options.every(({ label }) => !label.includes('link.md') && !label.includes('.hidden.md')))
    const answer = selections.shift()
    assert.ok(q.options.some(({ label }) => label === answer))
    if (answer === '返回列表') assert.match(q.detail, /Next step/)
    return [{ selected: [answer] }]
  } }, new AbortController().signal)
  assert.equal(selections.length, 0)
  await symlink(dir, join(parent, 'redirect'))
  await assert.rejects(viewArtifacts('redirect', {}, new AbortController().signal), /重定向/)
})

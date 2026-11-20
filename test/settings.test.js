import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { editSetting, saveSetting } from '../settings.js'

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'agy-settings-'))
  const previous = process.env.HOME
  process.env.HOME = home
  t.after(async () => {
    if (previous) process.env.HOME = previous
    else delete process.env.HOME
    await rm(home, { recursive: true, force: true })
  })
  const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  await mkdir(dirname(file), { recursive: true })
  return file
}

function answer(...steps) {
  return { async ask([q]) {
    const text = steps.shift()
    if (q.options.length) assert.ok(q.options.some(o => o.label === text), 'offered ' + text)
    return [{ selected: q.options.length ? [text] : [], custom: q.options.length ? undefined : text }]
  } }
}
const signal = () => new AbortController().signal

test('a cancelled global edit preserves exact file bytes; one confirmation changes only the selected field', async t => {
  const file = await setup(t)
  const original = '{\n  "other": {"keep": 1},\n  "agentMode": "auto"\n}\n'
  await writeFile(file, original, { mode: 0o600 })
  assert.equal(await editSetting(answer('agentMode', '"plan"', '取消'), signal(), false), false)
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal(await editSetting(answer('agentMode', '"plan"', '确认写入'), signal(), false), true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: { keep: 1 }, agentMode: 'plan' })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await editSetting(answer('agentMode', '继承原生默认值', '确认写入'), signal(), false)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: { keep: 1 } })
})

test('global rule creation, insertion and removal preserve adjacent lists and settings', async t => {
  const file = await setup(t)
  await editSetting(answer('ask', '添加规则', 'command(git status)', '确认写入'), signal(), true)
  await editSetting(answer('deny', '添加规则', 'write_file(notes)', '确认写入'), signal(), true)
  await editSetting(answer('ask', '移除 command(git status)', '确认写入'), signal(), true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permissions, { ask: [], deny: ['write_file(notes)'] })
})

test('a stale confirmation or malformed document cannot overwrite the native settings', async t => {
  const file = await setup(t)
  await writeFile(file, '{"agentMode":"plan"}')
  await assert.rejects(saveSetting(file, ['agentMode'], 'auto', 'accept-edits'), /修改/)
  await assert.rejects(saveSetting(file, ['unrelated'], undefined, 'test'), /不支持/)
  assert.equal(await readFile(file, 'utf8'), '{"agentMode":"plan"}')
  await writeFile(file, 'invalid')
  await assert.rejects(saveSetting(file, ['agentMode'], undefined, 'plan'))
  assert.equal(await readFile(file, 'utf8'), 'invalid')
})

test('a dangling symlink and an ambiguous duplicate key stay untouched', async t => {
  const file = await setup(t)
  await symlink('missing-target', file)
  await assert.rejects(editSetting(answer(), signal(), false), /符号链接/)
  assert.equal(await readlink(file), 'missing-target')
  await rm(file)
  const original = '{"agentMode":"auto","agentMode":"plan"}'
  await writeFile(file, original)
  await assert.rejects(saveSetting(file, ['agentMode'], 'plan', 'accept-edits'), /重复/)
  assert.equal(await readFile(file, 'utf8'), original)
})

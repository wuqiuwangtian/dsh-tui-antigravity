import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import jsonc from 'jsonc-parser'
import lockfile from 'proper-lockfile'

// Only fields whose native settings and value grammar we support are writable.
export const settings = new Map([
  ['agentMode', ['', 'plan', 'accept-edits', 'auto']],
  ['artifactReviewPolicy', ['asks-for-review', 'agent-decides', 'always-proceed']],
  ['toolPermission', ['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict']],
  ['enableTerminalSandbox', [true, false]],
  ['allowNonWorkspaceAccess', [false, true]],
])
const lists = ['deny', 'ask', 'allow']
const rule = /^(?:read_file|write_file|command|unsandboxed|read_url|execute_url|download_url|mcp)\([^\r\n]+\)$/u
const object = x => !!x && typeof x === 'object' && !Array.isArray(x)
const label = x => x === undefined ? '继承原生默认值' : JSON.stringify(x)

async function location() {
  const file = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  try { return await realpath(file) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const entry = await lstat(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause })
    if (entry?.isSymbolicLink()) throw new Error('settings.json 是失效的符号链接，请先修复。')
    return file
  }
}
async function snapshot(file) {
  let text
  try { text = await readFile(file, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { text: undefined, data: {} } }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('settings.json 无法解析，文件保持原样。') }
  if (!object(data)) throw new Error('settings.json 顶层必须是对象。')
  return { text, data }
}

export async function saveSetting(file, path, previous, value) {
  const [field, key] = path
  const policy = path.length === 2 && field === 'permissions' && lists.includes(key)
  if (!policy && !(path.length === 1 && settings.has(field) &&
      (value === undefined || settings.get(field).includes(value)))) throw new Error('不支持的设置或取值。')
  if (policy && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) throw new Error('无效权限列表。')
  if (file !== await location()) throw new Error('设置文件位置已改变，请重新确认。')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(file, { realpath: false, retries: 2 })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    const before = await snapshot(file)
    if (policy && before.data.permissions != null && !object(before.data.permissions)) throw new Error('原权限配置格式无效。')
    const actual = policy ? before.data.permissions?.[key] : before.data[field]
    if (!isDeepStrictEqual(actual, previous)) throw new Error('该字段已被其他程序修改，请重新查看后确认。')
    const text = before.text ?? '{}\n'
    const createPolicy = policy && before.data.permissions === null
    const edits = jsonc.modify(text, createPolicy ? [field] : path, createPolicy ? { [key]: value } : value,
      { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } })
    const updated = jsonc.applyEdits(text, edits)
    const expected = { ...before.data }
    if (policy) expected.permissions = { ...before.data.permissions, [key]: value }
    else if (value === undefined) delete expected[field]
    else expected[field] = value
    if (!isDeepStrictEqual(expected, JSON.parse(updated))) throw new Error('无法独立更新该字段，请检查是否有重复配置键。')
    if (updated === text) return
    const mode = before.text === undefined ? 0o600 : (await stat(file)).mode & 0o777
    const out = await open(temp, 'wx', mode)
    try { await out.writeFile(updated); await out.sync() } finally { await out.close() }
    if ((await snapshot(file)).text !== before.text) throw new Error('写入期间文件发生变化，请重试。')
    await rename(temp, file)
  } finally {
    try { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    finally { await release() }
  }
}

async function select(panels, signal, question, choices, detail) {
  const answer = await panels.ask([{ header: 'Antigravity 全局设置', question, detail,
    options: choices.map(label => ({ label })), hideCustomInput: true }], signal)
  return answer?.[0]?.selected?.[0]
}

export async function editSetting(panels, signal, permissions) {
  const file = await location()
  const { data } = await snapshot(file)
  let path, previous, value, summary
  if (permissions) {
    const key = await select(panels, signal, '选择全局规则列表', lists,
      'deny 优先于 ask，ask 优先于 allow。改动也会影响直接启动的 agy。')
    if (!lists.includes(key)) return false
    path = ['permissions', key]
    previous = data.permissions?.[key]
    const rows = previous ?? []
    if (!Array.isArray(rows) || !rows.every(v => typeof v === 'string')) throw new Error('现有权限列表格式不受支持。')
    const choices = ['返回', '添加规则', ...rows.map(v => '移除 ' + v)]
    const action = await select(panels, signal, key + ' 规则', choices)
    if (!action || action === '返回') return false
    if (action === '添加规则') {
      const answer = await panels.ask([{ question: '输入原生规则', detail: '例如 read_file(docs/) 或 command(git status)。', options: [] }], signal)
      const item = answer?.[0]?.custom?.trim()
      if (!item) return false
      if (!rule.test(item)) throw new Error('需要 action(target) 格式的原生权限规则。')
      if (rows.includes(item)) return false
      value = [...rows, item]
      summary = '新增 ' + item
    } else {
      const item = action.slice(3)
      if (!rows.includes(item)) return false
      value = rows.toSpliced(rows.indexOf(item), 1)
      summary = '移除 ' + item
    }
  } else {
    const field = await select(panels, signal, '选择要编辑的字段', [...settings.keys()])
    if (!settings.has(field)) return false
    path = [field]
    previous = data[field]
    const choices = [undefined, ...settings.get(field)]
    const selected = await select(panels, signal, field, choices.map(label), '当前全局值 · ' + label(previous))
    if (!selected) return false
    value = choices.find(v => label(v) === selected)
    if (value === previous) return false
    summary = label(previous) + ' → ' + label(value)
  }
  const confirmed = await select(panels, signal, '将此项写入 agy 全局设置？', ['取消', '确认写入'],
    path.join('.') + '\n' + summary + '\n' + file)
  if (confirmed !== '确认写入' || signal.aborted) return false
  await saveSetting(file, path, previous, value)
  return true
}

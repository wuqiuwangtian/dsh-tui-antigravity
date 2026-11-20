import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const windowSize = 2 * 1024 * 1024
const toolCalls = r => Array.isArray(r.tool_calls) ? r.tool_calls.filter(c => typeof c?.name === 'string') : []
const transcript = (root, id) => join(root, id, '.system_generated', 'logs', 'transcript.jsonl')

async function readRecords(root, id, signal) {
  const path = transcript(root, id)
  if (await realpath(path) !== path) throw new Error('会话记录路径已重定向。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('会话记录不是普通文件。')
    const partial = info.size > 2 * windowSize
    const ranges = partial ? [[0, windowSize], [info.size - windowSize, windowSize]] : [[0, info.size]]
    const records = []
    for (const [start, length] of ranges) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(length)
      let used = 0
      while (used < length) {
        const { bytesRead } = await file.read(buffer, used, length - used, start + used)
        if (!bytesRead) break
        used += bytesRead
      }
      const lines = buffer.toString('utf8', 0, used).split('\n')
      if (start > 0) lines.shift()
      if (partial && start === 0) lines.pop()
      for (const line of lines) {
        // An active writer may still be appending the final JSONL record.
        try { const record = JSON.parse(line); if (record && typeof record === 'object') records.push(record) } catch {}
      }
    }
    return { records, partial }
  } finally { await file.close() }
}

function children(records, root, parent) {
  const ids = new Set()
  let pending = 0
  for (const r of records) {
    if (r.type === 'PLANNER_RESPONSE' || r.type === 'USER_INPUT') {
      pending = toolCalls(r).filter(c => c.name === 'invoke_subagent').length
      continue
    }
    if (!pending || r.type !== 'GENERIC' || r.source !== 'MODEL' || typeof r.content !== 'string') continue
    const match = /^(?:(?:Created|Completed) At: [^\n]*\n)*Created the following subagent:\s*(\{[^{}]+\})/.exec(r.content)
    if (!match) continue
    let link
    try { link = JSON.parse(match[1]) } catch { continue }
    const id = link.conversationId
    if (!uuid.test(id) || id === parent || link.logAbsoluteUri !== pathToFileURL(transcript(root, id)).href) continue
    ids.add(id)
    pending--
  }
  return [...ids]
}

function childLines(records, parent) {
  const fromParent = records.some(r => r.type === 'SYSTEM_MESSAGE' && r.source === 'SYSTEM' &&
    typeof r.content === 'string' && r.content.includes('\n<SYSTEM_MESSAGE>\n[Message] ') &&
    r.content.split('\n').some(line => line.startsWith('[Message] timestamp=') && line.split(' content=')[0].includes(' sender=' + parent + ' ')))
  if (!fromParent) return ['原生记录尚未确认与当前父会话的关系。']
  const lines = []
  for (const r of records) {
    if (r.type !== 'PLANNER_RESPONSE' || r.source !== 'MODEL') continue
    for (const tool of toolCalls(r)) lines.push('工具 · ' + tool.name)
    if (typeof r.content === 'string' && r.content.trim()) lines.push(...r.content.trim().split('\n'))
  }
  return lines.length ? lines : ['尚无可显示的回复或工具活动。']
}

export async function viewTeam(parent, panels, signal) {
  if (!uuid.test(parent ?? '')) throw new Error('请先进入正式的 Antigravity 会话。')
  const select = async (question, options, detail) => {
    const answers = await panels.ask([{ header: 'Antigravity 子代理', question, detail,
      options: options.map(label => ({ label })), hideCustomInput: true }], signal)
    return answers?.[0]?.selected?.[0]
  }
  while (!signal.aborted) {
    let ids = [], root, partial
    try {
      root = await realpath(join(homedir(), '.gemini', 'antigravity-cli', 'brain'))
      const log = await readRecords(root, parent, signal)
      partial = log.partial
      ids = children(log.records, root, parent)
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    const chosen = await select(ids.length ? '选择当前会话的子代理' : '尚无可读取的子代理记录', ['关闭', '刷新', ...ids],
      partial ? '大记录仅读取开头和末尾，列表可能不完整。' : undefined)
    if (chosen === '刷新') continue
    if (!ids.includes(chosen)) return
    let page = 0
    while (!signal.aborted) {
      let lines
      try {
        const child = await readRecords(root, chosen, signal)
        lines = childLines(child.records, parent)
        if (child.partial) lines.unshift('大记录仅读取开头和末尾。')
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
        lines = ['子代理的本机记录尚未写入。']
      }
      const pages = Math.ceil(lines.length / 12)
      page = Math.min(page, pages - 1)
      const options = ['返回列表', '刷新']
      if (page) options.push('上一页')
      if (page + 1 < pages) options.push('下一页')
      const action = await select(chosen + ' · ' + (page + 1) + '/' + pages, options, lines.slice(page * 12, page * 12 + 12).join('\n'))
      if (!action) return
      if (action === '上一页') page--
      else if (action === '下一页') page++
      else if (action !== '刷新') break
    }
  }
}

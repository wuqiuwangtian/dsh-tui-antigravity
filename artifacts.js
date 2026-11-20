import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const limit = 128 * 1024
const isMarkdown = name => !name.startsWith('.') && !/[\/\\\x00-\x1f]/.test(name) && name.endsWith('.md')

export async function viewArtifacts(sessionId, panels, signal) {
  if (!/^[a-z0-9-]+$/i.test(sessionId ?? '')) throw new Error('需要有效的原生会话 ID。')
  const root = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
  let dir
  const names = []
  try {
    const parent = await realpath(root)
    dir = join(parent, sessionId)
    if (await realpath(dir) !== dir) throw new Error('产物目录发生重定向，请用原生 CLI 查看。')
    for await (const entry of await opendir(dir)) {
      if (entry.isFile() && isMarkdown(entry.name)) names.push(entry.name)
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  names.sort()
  const select = async (question, options, detail) => {
    const answers = await panels.ask([{ header: '会话产物', question, detail, options: options.map(label => ({ label })), hideCustomInput: true }], signal)
    return answers?.[0]?.selected[0]
  }
  while (!signal.aborted) {
    const name = await select(names.length ? '选择要预览的 Markdown 文档' : '本次会话没有可预览的 Markdown 产物', ['关闭', ...names])
    if (!names.includes(name)) return
    if (await realpath(dir) !== dir) throw new Error('产物目录已改变。')
    const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let lines
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('产物不是普通文件。')
      const bytes = Buffer.alloc(Math.min(info.size, limit))
      let offset = 0
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      lines = bytes.toString('utf8', 0, offset).split(/\r?\n/)
      if (info.size > limit) lines.push('仅预览前 128 KiB，完整文档可在原生 CLI 中查看。')
    } finally { await file.close() }
    const pages = Math.max(1, Math.ceil(lines.length / 12))
    let page = 0
    while (!signal.aborted) {
      const choices = ['返回列表']
      if (page) choices.push('上一页')
      if (page + 1 < pages) choices.push('下一页')
      const action = await select(name + ' · ' + (page + 1) + '/' + pages, choices, lines.slice(page * 12, (page + 1) * 12).join('\n'))
      if (!action) return
      if (action === '下一页') page++
      else if (action === '上一页') page--
      else break
    }
  }
}

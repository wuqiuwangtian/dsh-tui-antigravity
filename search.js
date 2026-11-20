import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Search only the current workspace. Query flags are translated, never forwarded.
export async function searchWorkspace(cwd, query, signal) {
  const args = ['--no-config', '--json', '--smart-case', '--context', '1']
  const pattern = []
  for (const token of query.trim().split(/\s+/)) {
    const glob = /^(-?)(?:f|file|path):(.+)$/.exec(token)
    if (glob) args.push('--glob', (glob[1] ? '!' : '') + glob[2])
    else if (token === '-F' || token === '--literal') args.push('--fixed-strings')
    else pattern.push(token)
  }
  if (!pattern.join(' ')) throw new Error('请输入搜索内容。')
  args.push('--', pattern.join(' '), '.')
  const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = new Promise(resolve => {
    child.once('error', () => resolve(-1))
    child.once('close', resolve)
  })
  const stop = () => child.kill()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 15000)
  const rows = [], context = new Map()
  let capped = false
  try {
    if (signal.aborted) stop()
    for await (const line of createInterface({ input: child.stdout })) {
      const { type, data } = JSON.parse(line)
      if (type !== 'match' && type !== 'context') continue
      const file = data.path?.text
      if (!file || !data.lines?.text) continue
      const number = data.line_number
      const text = data.lines.text.trimEnd().slice(0, 500)
      context.set(file + '\0' + number, text)
      if (type === 'match') rows.push({ file, number, text })
      if (rows.length >= 120) { capped = true; stop(); break }
    }
    const code = await closed
    signal.throwIfAborted()
    if (!capped && code !== 0 && code !== 1) throw new Error(code === -1 ? '请安装 ripgrep (rg) 后重试。' : '搜索未完成，请检查表达式或缩小范围。')
    return { rows, context, capped }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    stop()
    await closed
  }
}

export async function codeSearch(cwd, panels, signal, query) {
  const ask = async (question, options, detail) => {
    const answer = await panels.ask([{ header: '工作区代码搜索', question, detail, options: options.map(label => ({ label })), hideCustomInput: options.length > 0 }], signal)
    return options.length ? answer?.[0]?.selected?.[0] : answer?.[0]?.custom?.trim()
  }
  query ||= await ask('搜索当前工作区', [], '支持正则、-F 字面搜索、f: 路径过滤。')
  if (!query) return
  const { rows, context, capped } = await searchWorkspace(cwd, query, signal)
  let page = 0
  while (!signal.aborted) {
    const group = rows.slice(page * 8, (page + 1) * 8)
    const labels = group.map(r => r.file + ':' + r.number + '  ' + r.text.trim().slice(0, 65))
    const options = ['关闭', ...labels]
    if (page) options.push('上一页')
    if (rows.length > (page + 1) * 8) options.push('下一页')
    const selected = await ask(capped ? '显示前 120 个匹配' : rows.length + ' 个匹配', options, query)
    if (!selected || selected === '关闭') return
    if (selected === '上一页') { page--; continue }
    if (selected === '下一页') { page++; continue }
    const row = group[labels.indexOf(selected)]
    if (!row) return
    const lines = []
    for (let n = row.number - 1; n <= row.number + 1; n++) {
      const line = context.get(row.file + '\0' + n)
      if (line !== undefined) lines.push(n + ' │ ' + line)
    }
    if (!await ask(row.file + ':' + row.number, ['返回结果'], lines.join('\n'))) return
  }
}

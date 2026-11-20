import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { copyLoginLink, openBrowser } from './desktop.js'
import { executable } from './connection.js'

// Only agy exchanges and stores credentials. Keep the one-time code out of
// argv, events, error messages and logs, including child-process stderr.
export async function googleLogin(cwd, panels, signal) {
  const child = spawn(executable(), ['acp', '--login'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], signal })
  child.stdin.on('error', () => {})
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(false))
    child.once('close', code => resolve(code === 0))
  })
  const reader = createInterface({ input: child.stdout })
  const pending = new AbortController()
  const timeout = AbortSignal.timeout(300000)
  const dialogSignal = AbortSignal.any([signal, pending.signal, timeout])
  const stop = () => child.kill()
  dialogSignal.addEventListener('abort', stop, { once: true })
  let nativeSuccess = false
  void exited.then(ok => { nativeSuccess = ok; pending.abort() })
  try {
    for await (const line of reader) {
      let url
      try { url = new URL(line.trim()) } catch { continue }
      if (url.origin !== 'https://accounts.google.com' || url.username || url.password) continue
      // The host may fold its separate long-link row on a short terminal.
      // Put a compact, clickable OSC 8 label at the start of the prompt too.
      const visibleLink = '\x1b]8;;' + url.href + '\x1b\\https://accounts.google.com/… ↗\x1b]8;;\x1b\\'
      let opened = await openBrowser(url.href, dialogSignal)
      let note = opened ? '已请求打开浏览器' : '请打开下方 Google 链接'
      let code
      while (!dialogSignal.aborted) {
        const answer = await panels.ask([{ purpose: 'auth', header: 'Google 登录 · ' + note,
          question: visibleLink + '  粘贴一次性授权码或回跳网址。', link: url.href,
          options: [{ label: '复制完整授权链接' }, { label: '重新打开浏览器' }], secret: true }], dialogSignal)
        code = answer?.[0]?.custom?.trim()
        if (code || !answer || dialogSignal.aborted) break
        const selected = answer[0]?.selected?.[0]
        if (selected === '复制完整授权链接') {
          const copied = await copyLoginLink(url.href, dialogSignal)
          note = copied ? '已复制链接' : '复制失败，可从下方选取链接'
        } else if (selected === '重新打开浏览器') {
          opened = await openBrowser(url.href, dialogSignal)
          note = opened ? '已再次请求打开浏览器' : '请手动打开下方链接'
        } else break
      }
      if (signal.aborted) return false
      if (nativeSuccess) return true
      if (timeout.aborted) throw new Error('等待 Google 授权超时。请重新运行 /login。')
      if (pending.signal.aborted) throw new Error('agy 已结束本次授权。请重新运行 /login。')
      if (!code) return false
      if (/[\r\n]/.test(code)) throw new Error('授权码或回跳网址需要粘贴为单行。请重新运行 /login。')
      child.stdin.end(code + '\n')
      if (!await exited) throw new Error('Google 授权未完成。请重新运行 /login。')
      return true
    }
    if (!signal.aborted) throw new Error('未收到 agy 的 Google 授权链接。')
    return false
  } finally {
    reader.close()
    pending.abort()
    child.kill()
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(kill) }
  }
}

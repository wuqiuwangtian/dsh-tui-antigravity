import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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
  const dialogSignal = AbortSignal.any([signal, pending.signal, AbortSignal.timeout(300000)])
  const stop = () => child.kill()
  dialogSignal.addEventListener('abort', stop, { once: true })
  void exited.then(() => pending.abort())
  try {
    for await (const line of reader) {
      let url
      try { url = new URL(line.trim()) } catch { continue }
      if (url.origin !== 'https://accounts.google.com') continue
      const answer = await panels.ask([{ purpose: 'auth', header: 'Google 账号',
        question: '在浏览器中选择 Google 账号，再在此粘贴一次性授权码或回跳网址。',
        detail: '授权由 Antigravity CLI 完成。可按 Esc 取消。', link: url.href,
        options: [], secret: true }], dialogSignal)
      const code = answer?.[0]?.custom?.trim()
      if (!code || /[\r\n]/.test(code) || dialogSignal.aborted) return false
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
    await exited
  }
}

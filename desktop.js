import { spawn } from 'node:child_process'
import { release } from 'node:os'

function windowsTools(name) {
  // WSL installations can intentionally exclude Windows executables from PATH.
  return [name, '/mnt/c/Windows/System32/' + name]
}

function candidates(copy) {
  if (process.platform === 'win32') return copy ? ['clip.exe'] : ['rundll32.exe']
  if (process.platform === 'darwin') return copy ? ['pbcopy'] : ['open']
  const wsl = process.env.WSL_INTEROP || /microsoft/i.test(release())
  const linux = copy ? ['wl-copy', 'xclip', 'xsel'] : ['xdg-open']
  return wsl ? [...windowsTools(copy ? 'clip.exe' : 'rundll32.exe'), ...linux] : linux
}

function launch(command, args, input, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return }
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], windowsHide: true })
    let timer
    const done = ok => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(ok)
    }
    const abort = () => { child.kill(); done(false) }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', () => done(false))
    child.once('close', code => done(code === 0))
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      timer = setTimeout(abort, 3000)
    } else {
      // Some desktop openers remain alive for the lifetime of the browser.
      child.unref()
      timer = setTimeout(() => done(true), 800)
    }
  })
}

export async function openBrowser(url, signal) {
  const names = candidates(false)
  if (process.env.BROWSER) names.unshift(process.env.BROWSER)
  for (const name of names) {
    if (signal?.aborted) return false
    const args = name.endsWith('rundll32.exe') ? ['url.dll,FileProtocolHandler', url] : [url]
    if (await launch(name, args, undefined, signal)) return true
  }
  return false
}

export async function copyLoginLink(url, signal) {
  for (const name of candidates(true)) {
    if (signal?.aborted) return false
    const args = name === 'xclip' ? ['-selection', 'clipboard'] : name === 'xsel' ? ['--clipboard', '--input'] : []
    if (await launch(name, args, url, signal)) return true
  }
  return false
}

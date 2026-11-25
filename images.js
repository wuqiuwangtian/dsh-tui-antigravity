import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { imageSize } from 'image-size'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 8
const PROBE_BYTES = 256 * 1024
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const VALID_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function allowedImageRoots({ cwd, directories = [], sessionId } = {}) {
  const candidates = []
  if (cwd) candidates.push(cwd)
  for (const dir of directories) if (dir) candidates.push(dir)
  if (/^[a-z0-9-]+$/i.test(sessionId ?? '')) {
    candidates.push(join(homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId))
  }
  const roots = []
  for (const dir of candidates) {
    try {
      const real = realpathSync(dir)
      if (!roots.includes(real)) roots.push(real)
    } catch {}
  }
  return roots
}

function resolveCandidatePath(raw, cwd) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('file://')) {
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'file:') return undefined
      if (url.hostname && url.hostname !== 'localhost') return undefined
      return fileURLToPath(url)
    } catch {
      return undefined
    }
  }
  // Reject non-file URL schemes (http:, https:, data:, mailto:, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined
  const literal = isAbsolute(trimmed) ? trimmed : (cwd ? resolve(cwd, trimmed) : undefined)
  if (literal && existsSync(literal)) return literal
  if (/%[0-9A-Fa-f]{2}/.test(trimmed)) {
    try {
      const decoded = decodeURIComponent(trimmed)
      if (decoded !== trimmed) {
        return isAbsolute(decoded) ? decoded : (cwd ? resolve(cwd, decoded) : undefined)
      }
    } catch {}
  }
  return literal
}

function probeFileImageSize(path, size) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(Math.min(size, PROBE_BYTES))
    const bytesRead = readSync(fd, head, 0, head.length, 0)
    const info = imageSize(head.subarray(0, bytesRead))
    if (info?.width && info?.height && VALID_IMAGE_TYPES.has(String(info.type ?? '').toLowerCase())) {
      return { width: info.width, height: info.height }
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

export function transcriptImage(content) {
  if (typeof content?.data !== 'string' || !content.mimeType?.startsWith('image/')) return
  const buffer = Buffer.from(content.data, 'base64')
  try {
    const { width, height } = imageSize(buffer)
    if (!width || !height) return
    return {
      id: createHash('sha256').update(buffer).digest('hex'),
      width,
      height,
      bytes: buffer.length,
      mediaType: content.mimeType,
      read: async () => Buffer.from(content.data, 'base64'),
    }
  } catch {
    return undefined
  }
}

export function localTranscriptImage(rawPath, context = {}) {
  const candidate = resolveCandidatePath(rawPath, context.cwd)
  if (!candidate) return undefined
  const mediaType = MEDIA_TYPES[extname(candidate).toLowerCase()]
  if (!mediaType) return undefined
  const roots = context.roots ?? allowedImageRoots(context)
  if (!roots.length) return undefined
  let real, info
  try {
    real = realpathSync(candidate)
    if (!roots.some(root => isWithin(root, real))) return undefined
    info = statSync(real)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return undefined
  const dimensions = probeFileImageSize(real, info.size)
  if (!dimensions) return undefined
  const label = typeof context.name === 'string' && context.name.trim() ? context.name.trim() : basename(real)
  return {
    id: 'file:' + createHash('sha256').update(real).digest('hex').slice(0, 24),
    path: real,
    name: label,
    mediaType,
    width: dimensions.width,
    height: dimensions.height,
    bytes: info.size,
    async read(signal) {
      signal?.throwIfAborted()
      const current = await realpath(real)
      if (!roots.some(root => isWithin(root, current))) throw new Error('Image path moved outside session roots')
      const currentInfo = await stat(current)
      if (!currentInfo.isFile() || currentInfo.size > MAX_IMAGE_BYTES) throw new Error('Image is unavailable or too large')
      const data = await readFile(current, { signal })
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    },
  }
}

function stripMarkdownCode(text) {
  const lines = text.split(/\r?\n/u)
  const kept = []
  let fence
  for (const line of lines) {
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        fence = open[1]
        continue
      }
      kept.push(line)
    } else {
      const close = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$')
      if (close.test(line)) fence = undefined
    }
  }
  return kept.join('\n').replace(/(`+)[\s\S]*?\1/g, ' ')
}

const MARKDOWN_IMAGE = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|((?:[^\s()\r\n]|\([^\s()\r\n]*\))+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)/g

export function markdownImages(text, context = {}, limit = MAX_IMAGES_PER_MESSAGE) {
  if (typeof text !== 'string' || !text.includes('![')) return []
  const roots = allowedImageRoots(context)
  if (!roots.length) return []
  const cleaned = stripMarkdownCode(text)
  const seen = new Set()
  const images = []
  for (const match of cleaned.matchAll(MARKDOWN_IMAGE)) {
    const alt = match[1]
    const href = match[2] ?? match[3]
    const image = localTranscriptImage(href, { ...context, roots, name: alt })
    if (!image || seen.has(image.path)) continue
    seen.add(image.path)
    images.push(image)
    if (images.length >= limit) break
  }
  return images
}

import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { imageSize } from 'image-size'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 8
const PROBE_BYTES = 256 * 1024
const CHUNK_BYTES = 64 * 1024
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const DETECTED_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

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

function probeAndHashFileSync(real) {
  let fd
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return undefined
    const probeTarget = Math.min(info.size, PROBE_BYTES)
    const probeChunks = []
    let probeBytes = 0
    const hash = createHash('sha256')
    const scratch = Buffer.allocUnsafe(CHUNK_BYTES)
    let total = 0
    while (true) {
      const bytesRead = readSync(fd, scratch, 0, scratch.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_IMAGE_BYTES) return undefined
      const slice = scratch.subarray(0, bytesRead)
      hash.update(slice)
      if (probeBytes < probeTarget) {
        const take = Math.min(bytesRead, probeTarget - probeBytes)
        probeChunks.push(Buffer.from(slice.subarray(0, take)))
        probeBytes += take
      }
    }
    if (total === 0) return undefined
    const header = probeChunks.length === 1 ? probeChunks[0] : Buffer.concat(probeChunks, probeBytes)
    const probed = imageSize(header)
    const mediaType = DETECTED_MEDIA_TYPES[String(probed?.type ?? '').toLowerCase()]
    if (!probed?.width || !probed?.height || !mediaType) return undefined
    return {
      width: probed.width,
      height: probed.height,
      bytes: total,
      mediaType,
      sha256: hash.digest('hex'),
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function transcriptImage(content) {
  if (typeof content?.data !== 'string' || !content.mimeType?.startsWith('image/')) return
  const buffer = Buffer.from(content.data, 'base64')
  try {
    const probed = imageSize(buffer)
    const mediaType = DETECTED_MEDIA_TYPES[String(probed?.type ?? '').toLowerCase()] ?? content.mimeType
    if (!probed?.width || !probed?.height) return
    return {
      id: createHash('sha256').update(buffer).digest('hex'),
      width: probed.width,
      height: probed.height,
      bytes: buffer.length,
      mediaType,
      read: async () => Buffer.from(content.data, 'base64'),
    }
  } catch {
    return undefined
  }
}

export function localTranscriptImage(rawPath, context = {}) {
  const candidate = resolveCandidatePath(rawPath, context.cwd)
  if (!candidate || !ALLOWED_EXTENSIONS.has(extname(candidate).toLowerCase())) return undefined
  const roots = context.roots ?? allowedImageRoots(context)
  if (!roots.length) return undefined
  let real
  try {
    real = realpathSync(candidate)
    if (!roots.some(root => isWithin(root, real))) return undefined
  } catch {
    return undefined
  }
  const verified = probeAndHashFileSync(real)
  if (!verified) return undefined
  const label = typeof context.name === 'string' && context.name.trim() ? context.name.trim() : basename(real)
  return {
    id: 'file:' + verified.sha256.slice(0, 24),
    path: real,
    name: label,
    mediaType: verified.mediaType,
    width: verified.width,
    height: verified.height,
    bytes: verified.bytes,
    async read(signal) {
      signal?.throwIfAborted()
      const current = await realpath(real)
      if (!roots.some(root => isWithin(root, current))) throw new Error('Image path moved outside session roots')
      const fh = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const currentInfo = await fh.stat()
        if (!currentInfo.isFile() || currentInfo.size <= 0 || currentInfo.size > MAX_IMAGE_BYTES) {
          throw new Error('Image is unavailable or too large')
        }
        const chunks = []
        const hash = createHash('sha256')
        const scratch = Buffer.allocUnsafe(CHUNK_BYTES)
        let total = 0
        while (true) {
          signal?.throwIfAborted()
          const { bytesRead } = await fh.read(scratch, 0, scratch.length, null)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > MAX_IMAGE_BYTES) throw new Error('Image exceeds size limit')
          const copy = Buffer.from(scratch.subarray(0, bytesRead))
          hash.update(copy)
          chunks.push(copy)
        }
        if (total !== verified.bytes || hash.digest('hex') !== verified.sha256) {
          throw new Error('Image file changed since it was recorded')
        }
        const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } finally {
        await fh.close()
      }
    },
  }
}

function leadingColumns(line) {
  let cols = 0
  for (const ch of line) {
    if (ch === ' ') cols += 1
    else if (ch === '\t') cols += 4 - (cols % 4)
    else break
  }
  return cols
}

function stripMarkdownCode(text) {
  const lines = text.split(/\r?\n/u)
  const kept = []
  let fence
  let inParagraph = false
  let listIndent
  for (const line of lines) {
    if (fence) {
      const close = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$')
      if (close.test(line)) fence = undefined
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = open[1]
      inParagraph = false
      continue
    }
    if (/^[ \t]*$/.test(line)) {
      inParagraph = false
      kept.push(line)
      continue
    }
    const indent = leadingColumns(line)
    const codeThreshold = listIndent !== undefined ? listIndent + 4 : 4
    if (!inParagraph && indent >= codeThreshold) continue
    if (listIndent !== undefined && indent < listIndent) listIndent = undefined
    const listMarker = /^( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(line)
    if (listMarker) {
      listIndent = leadingColumns(listMarker[1].replace(/[^ \t]/g, ' '))
      inParagraph = true
      kept.push(line)
      continue
    }
    inParagraph = true
    kept.push(line)
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

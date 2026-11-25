import { closeSync, constants, existsSync, fstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { open, readlink, realpath, stat } from 'node:fs/promises'
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

function resolveAllowedRealPath(rawPath, { cwd, roots }) {
  const candidate = resolveCandidatePath(rawPath, cwd)
  if (!candidate || !ALLOWED_EXTENSIONS.has(extname(candidate).toLowerCase())) return undefined
  if (!roots.length) return undefined
  try {
    const real = realpathSync(candidate)
    return roots.some(root => isWithin(root, real)) ? real : undefined
  } catch {
    return undefined
  }
}

function verifyOpenedFdSync(fd, expectedReal, roots) {
  const fdStat = fstatSync(fd)
  if (!fdStat.isFile() || fdStat.size <= 0 || fdStat.size > MAX_IMAGE_BYTES) return undefined
  if (process.platform === 'linux') {
    const fdPath = readlinkSync('/proc/self/fd/' + fd)
    if (fdPath.endsWith(' (deleted)') || !roots.some(root => isWithin(root, fdPath))) return undefined
  }
  const currentReal = realpathSync(expectedReal)
  if (!roots.some(root => isWithin(root, currentReal))) return undefined
  const currentStat = statSync(currentReal)
  if (currentStat.dev !== fdStat.dev || currentStat.ino !== fdStat.ino) return undefined
  return fdStat
}

async function verifyOpenedHandle(fh, expectedReal, roots) {
  const fdStat = await fh.stat()
  if (!fdStat.isFile() || fdStat.size <= 0 || fdStat.size > MAX_IMAGE_BYTES) return undefined
  if (process.platform === 'linux') {
    const fdPath = await readlink('/proc/self/fd/' + fh.fd)
    if (fdPath.endsWith(' (deleted)') || !roots.some(root => isWithin(root, fdPath))) return undefined
  }
  const currentReal = await realpath(expectedReal)
  if (!roots.some(root => isWithin(root, currentReal))) return undefined
  const currentStat = await stat(currentReal)
  if (currentStat.dev !== fdStat.dev || currentStat.ino !== fdStat.ino) return undefined
  return fdStat
}

function probeAndHashFileSync(real, roots) {
  let fd
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = verifyOpenedFdSync(fd, real, roots)
    if (!info) return undefined
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

function buildLocalFacade(real, roots, name) {
  const verified = probeAndHashFileSync(real, roots)
  if (!verified) return undefined
  const label = typeof name === 'string' && name.trim() ? name.trim() : basename(real)
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
      const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const currentInfo = await verifyOpenedHandle(fh, real, roots)
        if (!currentInfo) throw new Error('Image path moved outside session roots or is unavailable')
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

export function localTranscriptImage(rawPath, context = {}) {
  const roots = context.roots ?? allowedImageRoots(context)
  const real = resolveAllowedRealPath(rawPath, { cwd: context.cwd, roots })
  if (!real) return undefined
  return buildLocalFacade(real, roots, context.name)
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

function peelBlockquotes(line) {
  let depth = 0
  let rest = line
  while (true) {
    const match = /^ {0,3}>[ \t]?/.exec(rest)
    if (!match) break
    depth += 1
    rest = rest.slice(match[0].length)
  }
  return { depth, text: rest }
}

function stripMarkdownCode(text) {
  const lines = text.split(/\r?\n/u)
  const kept = []
  let quoteDepth = 0
  let fence
  let inParagraph = false
  let listIndent
  for (const rawLine of lines) {
    const { depth, text: line } = peelBlockquotes(rawLine)
    if (depth !== quoteDepth) {
      quoteDepth = depth
      fence = undefined
      inParagraph = false
      listIndent = undefined
    }
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
    // ATX headings and thematic breaks terminate any preceding paragraph and
    // cannot be continued by an indented line on the following row.
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) || /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      inParagraph = false
      kept.push(line)
      continue
    }
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

export function markdownImages(text, context = {}, limit = MAX_IMAGES_PER_MESSAGE, existingPaths) {
  if (typeof text !== 'string' || !text.includes('![')) return []
  const roots = allowedImageRoots(context)
  if (!roots.length) return []
  const cleaned = stripMarkdownCode(text)
  const seen = new Set(existingPaths)
  const images = []
  for (const match of cleaned.matchAll(MARKDOWN_IMAGE)) {
    const alt = match[1]
    const href = match[2] ?? match[3]
    const real = resolveAllowedRealPath(href, { cwd: context.cwd, roots })
    if (!real || seen.has(real)) continue
    seen.add(real)
    const image = buildLocalFacade(real, roots, alt)
    if (!image) continue
    images.push(image)
    if (images.length >= limit) break
  }
  return images
}

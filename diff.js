const DEFAULT_CONTEXT = 3
const MAX_EDIT_LENGTH = 1500
const DIFF_TIMEOUT_MS = 80

function splitLines(text) {
  if (!text) return []
  const lines = []
  let start = 0
  while (start < text.length) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) {
      lines.push(text.slice(start))
      break
    }
    // Normalize CRLF to LF for line comparison so whole-file line-ending
    // conversions do not mask localized edits, while keeping '\n' to preserve
    // trailing-newline differences at EOF.
    const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl
    lines.push(text.slice(start, end) + '\n')
    start = nl + 1
  }
  return lines
}

function formatLine(prefix, raw) {
  const hasNl = raw.endsWith('\n')
  const body = (hasNl ? raw.slice(0, -1) : raw).replace(/\r$/, '')
  return hasNl ? [prefix + body] : [prefix + body, '\\ No newline at end of file']
}

// Compute a minimal edit script on a[0..n) vs b[0..m) via Myers' O(ND) diff.
// Returns undefined when the edit distance or time budget is exceeded.
function myersOps(a, b, maxEditLength, timeoutMs) {
  const n = a.length
  const m = b.length
  const maxD = Math.min(n + m, maxEditLength)
  const offset = maxD + 1
  const v = new Int32Array(2 * offset + 1)
  const trace = []
  const deadline = performance.now() + timeoutMs

  let finalD = -1
  for (let d = 0; d <= maxD; d++) {
    if (d > 0 && (d & 31) === 0 && performance.now() > deadline) return undefined
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]
      } else {
        x = v[k - 1 + offset] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + offset] = x
      if (x === n && y === m) {
        finalD = d
        break
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
    if (finalD !== -1) break
  }
  if (finalD === -1) return undefined

  const ops = []
  let x = n
  let y = m
  for (let d = finalD; d > 0; d--) {
    const prev = trace[d - 1]
    const prevOffset = d - 1
    const k = x - y
    const prevK = (k === -d || (k !== d && prev[k - 1 + prevOffset] < prev[k + 1 + prevOffset]))
      ? k + 1 : k - 1
    const prevX = prev[prevK + prevOffset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', aIdx: x - 1, bIdx: y - 1 })
      x--
      y--
    }
    if (x === prevX) {
      ops.push({ type: 'add', bIdx: y - 1 })
      y--
    } else {
      ops.push({ type: 'del', aIdx: x - 1 })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'eq', aIdx: x - 1, bIdx: y - 1 })
    x--
    y--
  }
  ops.reverse()
  return ops
}

// Group contiguous del/add runs so removals always precede additions, matching
// git unified diff output and SplitDiffView's side-by-side block pairing.
function normalizeEditRuns(ops) {
  const out = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === 'eq') {
      out.push(ops[i++])
      continue
    }
    const dels = []
    const adds = []
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels.push(ops[i])
      else adds.push(ops[i])
      i++
    }
    for (const op of dels) out.push(op)
    for (const op of adds) out.push(op)
  }
  return out
}

export function unifiedDiffPatch(oldText, newText, options = {}) {
  if (oldText === newText) return ''
  const context = options.context ?? DEFAULT_CONTEXT
  const maxEditLength = options.maxEditLength ?? MAX_EDIT_LENGTH
  const timeoutMs = options.timeoutMs ?? DIFF_TIMEOUT_MS

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++

  let suffix = 0
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix)
  while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)
  if (!midOld.length && !midNew.length) return ''

  let midOps
  if (!midOld.length) {
    midOps = midNew.map((_, idx) => ({ type: 'add', bIdx: idx }))
  } else if (!midNew.length) {
    midOps = midOld.map((_, idx) => ({ type: 'del', aIdx: idx }))
  } else {
    midOps = myersOps(midOld, midNew, maxEditLength, timeoutMs)
    if (!midOps) {
      // Over budget: replace only the trimmed differing slice so unchanged
      // leading/trailing lines stay out of the hunk.
      midOps = [
        ...midOld.map((_, idx) => ({ type: 'del', aIdx: idx })),
        ...midNew.map((_, idx) => ({ type: 'add', bIdx: idx })),
      ]
    }
  }

  // Build windowed ops: up to `context` leading lines from prefix, the middle
  // edit ops shifted to full-file indices, and up to `context` trailing lines.
  const leadCount = Math.min(prefix, context)
  const trailCount = Math.min(suffix, context)
  const fullOps = []
  for (let i = prefix - leadCount; i < prefix; i++) fullOps.push({ type: 'eq', aIdx: i, bIdx: i })
  for (const op of normalizeEditRuns(midOps)) {
    if (op.type === 'eq') fullOps.push({ type: 'eq', aIdx: op.aIdx + prefix, bIdx: op.bIdx + prefix })
    else if (op.type === 'del') fullOps.push({ type: 'del', aIdx: op.aIdx + prefix })
    else fullOps.push({ type: 'add', bIdx: op.bIdx + prefix })
  }
  const oldSuffixStart = oldLines.length - suffix
  const newSuffixStart = newLines.length - suffix
  for (let i = 0; i < trailCount; i++) fullOps.push({ type: 'eq', aIdx: oldSuffixStart + i, bIdx: newSuffixStart + i })

  // Partition fullOps into hunks separated by runs of > 2 * context equal lines.
  const hunks = []
  let idx = 0
  let curOld = prefix - leadCount
  let curNew = prefix - leadCount
  let cursorPos = 0
  const advanceCursorTo = target => {
    while (cursorPos < target) {
      const op = fullOps[cursorPos++]
      if (op.type === 'eq') { curOld++; curNew++ }
      else if (op.type === 'del') curOld++
      else curNew++
    }
  }
  while (idx < fullOps.length) {
    while (idx < fullOps.length && fullOps[idx].type === 'eq') idx++
    if (idx >= fullOps.length) break
    const start = Math.max(0, idx - context)
    let end = idx
    while (end < fullOps.length) {
      while (end < fullOps.length && fullOps[end].type !== 'eq') end++
      let eqEnd = end
      while (eqEnd < fullOps.length && fullOps[eqEnd].type === 'eq') eqEnd++
      if (eqEnd >= fullOps.length || eqEnd - end > 2 * context) {
        end = Math.min(eqEnd, end + context)
        break
      }
      end = eqEnd
    }

    advanceCursorTo(start)
    const hunkStartOld = curOld
    const hunkStartNew = curNew
    const slice = fullOps.slice(start, end)
    let oldCount = 0
    let newCount = 0
    let firstOld = -1
    let firstNew = -1
    const body = []
    for (const op of slice) {
      if (op.type === 'eq') {
        if (firstOld === -1) firstOld = op.aIdx
        if (firstNew === -1) firstNew = op.bIdx
        oldCount++
        newCount++
        body.push(...formatLine(' ', oldLines[op.aIdx]))
      } else if (op.type === 'del') {
        if (firstOld === -1) firstOld = op.aIdx
        oldCount++
        body.push(...formatLine('-', oldLines[op.aIdx]))
      } else {
        if (firstNew === -1) firstNew = op.bIdx
        newCount++
        body.push(...formatLine('+', newLines[op.bIdx]))
      }
    }
    const oldStart = oldCount === 0 ? hunkStartOld : firstOld + 1
    const newStart = newCount === 0 ? hunkStartNew : firstNew + 1
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}`)
    idx = end
  }

  return hunks.length ? hunks.join('\n') + '\n' : ''
}

export function toToolFileDiff(item) {
  const oldText = typeof item.oldText === 'string' ? item.oldText : null
  const newText = typeof item.newText === 'string' ? item.newText : ''
  if (oldText === null || oldText === '') {
    return { path: item.path, oldText: null, newText, newStart: 1 }
  }
  if (newText === '') {
    return { path: item.path, oldText, newText: '', oldStart: 1 }
  }
  return { path: item.path, patch: unifiedDiffPatch(oldText, newText), change: 'update' }
}

export function isNewFileDiff(diff) {
  return !('patch' in diff) && (diff.oldText == null || diff.oldText === '')
}

export function formatDiffText(diff) {
  if ('patch' in diff) {
    return diff.patch ? `${diff.path}\n${diff.patch.replace(/\n$/, '')}` : diff.path
  }
  return [diff.path, '---', diff.oldText ?? '', '+++', diff.newText ?? ''].join('\n')
}

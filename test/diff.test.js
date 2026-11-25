import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDiffText, isNewFileDiff, toToolFileDiff, unifiedDiffPatch } from '../diff.js'

test('unifiedDiffPatch emits compact numbered hunks without leading unchanged lines', () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`)
  const edited = [...lines]
  edited[694] = 'line 695 edited'

  const patch = unifiedDiffPatch(lines.join('\n') + '\n', edited.join('\n') + '\n')
  assert.equal(patch, [
    '@@ -692,7 +692,7 @@',
    ' line 692',
    ' line 693',
    ' line 694',
    '-line 695',
    '+line 695 edited',
    ' line 696',
    ' line 697',
    ' line 698',
    '',
  ].join('\n'))
  assert.ok(!patch.includes('line 1\n'))
})

test('unifiedDiffPatch separates distant hunks and merges nearby edits', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`)
  const edited = [...lines]
  edited[4] = 'L5-A'
  edited[9] = 'L10-B' // 4 unchanged lines between L5 and L10 -> merged into one hunk
  edited[34] = 'L35-C' // > 6 unchanged lines after L10 -> separate hunk

  const patch = unifiedDiffPatch(lines.join('\n') + '\n', edited.join('\n') + '\n')
  const headers = patch.match(/^@@ .+ @@$/gm)
  assert.deepEqual(headers, [
    '@@ -2,12 +2,12 @@',
    '@@ -32,7 +32,7 @@',
  ])
  assert.ok(patch.includes('-L5\n+L5-A'))
  assert.ok(patch.includes('-L10\n+L10-B'))
  assert.ok(patch.includes('-L35\n+L35-C'))
})

test('unifiedDiffPatch handles insertions, deletions, EOF newlines, CRLF, identical text, and budget fallback', () => {
  assert.equal(unifiedDiffPatch('same\n', 'same\n'), '')

  // Pure insertion at line 4 with context
  const ins = unifiedDiffPatch('a\nb\nc\nd\n', 'a\nb\nc\nx\ny\nd\n')
  assert.equal(ins, [
    '@@ -1,4 +1,6 @@',
    ' a',
    ' b',
    ' c',
    '+x',
    '+y',
    ' d',
    '',
  ].join('\n'))

  // Trailing newline added at EOF
  const eofNl = unifiedDiffPatch('one\ntwo', 'one\ntwo\n')
  assert.equal(eofNl, [
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '\\ No newline at end of file',
    '+two',
    '',
  ].join('\n'))

  // CRLF lines produce clean display lines without stray \r
  const crlf = unifiedDiffPatch('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')
  assert.ok(!crlf.includes('\r'))
  assert.equal(crlf, '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')

  // Over-budget fallback still trims unchanged prefix/suffix and keeps valid counts
  const bigOld = Array.from({ length: 50 }, (_, i) => i < 20 || i >= 30 ? `keep ${i + 1}` : `old ${i + 1}`).join('\n') + '\n'
  const bigNew = Array.from({ length: 50 }, (_, i) => i < 20 || i >= 30 ? `keep ${i + 1}` : `new ${i + 1}`).join('\n') + '\n'
  const fallback = unifiedDiffPatch(bigOld, bigNew, { maxEditLength: 2 })
  assert.ok(fallback.startsWith('@@ -18,16 +18,16 @@\n'))
  assert.ok(!fallback.includes('keep 1\n'))
})

test('toToolFileDiff classifies new, deleted, and updated files correctly', () => {
  const added = toToolFileDiff({ path: 'a.js', oldText: null, newText: 'hello\n' })
  assert.deepEqual(added, { path: 'a.js', oldText: null, newText: 'hello\n', newStart: 1 })
  assert.equal(isNewFileDiff(added), true)

  const deleted = toToolFileDiff({ path: 'b.js', oldText: 'gone\n', newText: '' })
  assert.deepEqual(deleted, { path: 'b.js', oldText: 'gone\n', newText: '', oldStart: 1 })
  assert.equal(isNewFileDiff(deleted), false)

  const edited = toToolFileDiff({ path: 'c.js', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' })
  assert.equal(edited.change, 'update')
  assert.equal(edited.patch, '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
  assert.equal(isNewFileDiff(edited), false)
  assert.equal(formatDiffText(edited), 'c.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
})

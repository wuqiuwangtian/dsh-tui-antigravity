import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWorkspace } from '../search.js'
import { spawnSync } from 'node:child_process'

test('code search applies fixed strings, glob scope, and preserves line context', {
  skip: spawnSync('rg', ['--version']).status !== 0,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-search-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'example.txt'), 'previous\nMap[Key]\nafter\n')
  await writeFile(join(dir, 'other.md'), 'Map[Key]\n')
  const { rows, context } = await searchWorkspace(dir, '-F f:*.txt Map[Key]', new AbortController().signal)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].number, 2)
  assert.equal(context.get(rows[0].file + '\0' + 1), 'previous')
})

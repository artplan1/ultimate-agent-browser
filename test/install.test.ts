import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installGlobal } from '../install.ts'

test('local installation links this checkout, is repeatable, and refuses to replace existing files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-browser-install-test-'))
  try {
    const target = join(home, 'extensions', 'agent-browser')
    const source = await installGlobal(target)
    assert.ok((await lstat(target)).isSymbolicLink())
    assert.equal(await realpath(target), source)
    assert.equal(await installGlobal(target), source)

    const occupied = join(home, 'occupied', 'agent-browser')
    await mkdir(occupied, { recursive: true })
    await writeFile(join(occupied, 'existing.txt'), 'keep this extension')
    await assert.rejects(installGlobal(occupied), /nothing was replaced/)
    assert.equal(await readFile(join(occupied, 'existing.txt'), 'utf8'), 'keep this extension')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

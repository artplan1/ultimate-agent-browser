import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Link this checkout into Ultimate without replacing an existing extension. */
export async function installGlobal(
  target = join(homedir(), '.ultimate', 'extensions', 'agent-browser'),
) {
  const source = await realpath(fileURLToPath(new URL('.', import.meta.url)))
  let existing
  try {
    existing = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing) {
    if (existing.isSymbolicLink() && (await realpath(target)) === source) return source
    throw new Error(
      `An extension already exists at ${target}. Move it outside the extensions directory before installing; nothing was replaced.`,
    )
  }
  await mkdir(dirname(target), { recursive: true })
  await symlink(source, target, 'dir')
  return source
}

if (import.meta.main) {
  console.log(`Global agent-browser linked to ${await installGlobal()}`)
}

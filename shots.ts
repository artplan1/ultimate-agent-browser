import { readFile } from 'node:fs/promises'
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent'

/** A saved PNG as the image and note a tool result carries. */
export async function thumbnail(file: string) {
  const png = await readFile(file)
  const resized = await resizeImage(png, 'image/png', { maxWidth: 1600, maxHeight: 1600 })
  return {
    file,
    image: resized
      ? { type: 'image' as const, mimeType: resized.mimeType, data: resized.data }
      : undefined,
    note: resized
      ? formatDimensionNote(resized)
      : '[Image omitted: could not be resized below the inline image size limit.]',
  }
}

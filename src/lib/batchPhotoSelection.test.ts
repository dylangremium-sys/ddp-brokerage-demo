import { describe, expect, it } from 'vitest'
import {
  addPhoto,
  removePhotoAt,
  fromStoredPreviews,
  toPreviews,
  toUploadFiles,
  MAX_PHOTOS_PER_BATCH,
  type SelectedPhoto,
} from './batchPhotoSelection'

function f(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' })
}

describe('addPhoto', () => {
  it('puts the newest photo first', () => {
    const a = addPhoto([], 'data:a', f('a.jpg'))
    const b = addPhoto(a, 'data:b', f('b.jpg'))
    expect(toPreviews(b)).toEqual(['data:b', 'data:a'])
  })

  it('caps the list and drops the OLDEST, never the newest', () => {
    let list: SelectedPhoto[] = []
    for (let i = 1; i <= MAX_PHOTOS_PER_BATCH + 2; i++) {
      list = addPhoto(list, `data:${i}`, f(`${i}.jpg`))
    }
    expect(list).toHaveLength(MAX_PHOTOS_PER_BATCH)
    // The photo just taken must be present. Dropping it would mean the farmer
    // watches their photo appear and then vanish.
    expect(list[0].preview).toBe(`data:${MAX_PHOTOS_PER_BATCH + 2}`)
    expect(toPreviews(list)).not.toContain('data:1')
  })

  it('does not mutate the input', () => {
    const original: SelectedPhoto[] = [{ preview: 'data:a', file: f('a.jpg') }]
    addPhoto(original, 'data:b', f('b.jpg'))
    expect(original).toHaveLength(1)
  })
})

describe('removePhotoAt — the invariant this module exists to protect', () => {
  it('removes the preview AND its bytes together', () => {
    const fa = f('a.jpg'); const fb = f('b.jpg'); const fc = f('c.jpg')
    let list = addPhoto(addPhoto(addPhoto([], 'data:a', fa), 'data:b', fb), 'data:c', fc)
    // Order is now c, b, a. Remove the middle one.
    list = removePhotoAt(list, 1)
    expect(toPreviews(list)).toEqual(['data:c', 'data:a'])
    // The critical assertion: b's FILE is gone too. With parallel arrays this is
    // exactly where the deleted photo would still get uploaded.
    expect(toUploadFiles(list)).toEqual([fc, fa])
    expect(toUploadFiles(list)).not.toContain(fb)
  })

  it('keeps previews and files aligned after several removals', () => {
    let list = fromStoredPreviews([])
    const files = ['a', 'b', 'c', 'd'].map(n => f(`${n}.jpg`))
    files.forEach((file, i) => { list = addPhoto(list, `data:${i}`, file) })
    list = removePhotoAt(list, 0)
    list = removePhotoAt(list, list.length - 1)
    // Whatever survived, every entry's preview must still belong to its own file.
    for (const entry of list) {
      const idx = Number(entry.preview.replace('data:', ''))
      expect(entry.file).toBe(files[idx])
    }
  })

  it('returns the list unchanged for an out-of-range index', () => {
    const list = addPhoto([], 'data:a', f('a.jpg'))
    expect(removePhotoAt(list, 5)).toHaveLength(1)
    expect(removePhotoAt(list, -1)).toHaveLength(1)
  })
})

describe('draft-restored previews', () => {
  it('carry no bytes, so nothing is re-uploaded', () => {
    const list = fromStoredPreviews(['data:old1', 'data:old2'])
    expect(toPreviews(list)).toEqual(['data:old1', 'data:old2'])
    // Uploading these would be impossible anyway — but returning them as files
    // would make the caller believe two photos are pending upload.
    expect(toUploadFiles(list)).toEqual([])
  })

  it('treats undefined as an empty selection', () => {
    expect(fromStoredPreviews(undefined)).toEqual([])
  })

  it('uploads only the newly added photo when mixed with restored ones', () => {
    const fresh = f('new.jpg')
    const list = addPhoto(fromStoredPreviews(['data:old']), 'data:new', fresh)
    expect(toPreviews(list)).toEqual(['data:new', 'data:old'])
    expect(toUploadFiles(list)).toEqual([fresh])
  })
})

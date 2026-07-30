/**
 * The farmer's in-progress photo selection.
 *
 * WHY THIS IS A MODULE AND NOT INLINE STATE
 *   A photo has two halves: the preview the farmer sees, and the bytes that get
 *   uploaded. Held as two parallel arrays and kept in step by hand, the remove
 *   button — which deletes by index — is one off-by-one away from uploading the
 *   photo the farmer just deleted, or dropping one they kept. Neither failure is
 *   visible in the UI: the thumbnails would look exactly right.
 *
 *   That matters more than usual here, because the defect this whole path
 *   replaces was silent photo loss. Swapping one silent loss for another, subtler
 *   one would be a poor trade. So the invariant — a preview and its bytes are one
 *   indivisible entry — is enforced by the data structure, and the operations on
 *   it live here where they can be tested without a browser.
 */

/** The most photos a farmer may attach to one batch. */
export const MAX_PHOTOS_PER_BATCH = 4

/**
 * One selected photo.
 *
 * `file` is null for an entry restored from a saved draft: the preview came back
 * as a stored string and there are no bytes to re-upload. Such an entry is
 * displayable but not uploadable, and the two must never be confused.
 */
export interface SelectedPhoto {
  preview: string
  file: File | null
}

/**
 * Add a newly captured photo.
 *
 * Newest first, matching the original UI order, and capped at
 * MAX_PHOTOS_PER_BATCH by dropping the OLDEST — so the photo the farmer just
 * took is never the one silently discarded.
 */
export function addPhoto(
  current: readonly SelectedPhoto[],
  preview: string,
  file: File,
): SelectedPhoto[] {
  return [{ preview, file }, ...current].slice(0, MAX_PHOTOS_PER_BATCH)
}

/**
 * Remove the entry at `index`.
 *
 * Out-of-range indices return the list unchanged rather than throwing: a stale
 * click during a re-render must not blow up the form the farmer is filling in.
 */
export function removePhotoAt(
  current: readonly SelectedPhoto[],
  index: number,
): SelectedPhoto[] {
  if (index < 0 || index >= current.length) return [...current]
  return current.filter((_, i) => i !== index)
}

/** Restore a draft's previews. They carry no bytes, so `file` is null. */
export function fromStoredPreviews(previews: readonly string[] | undefined): SelectedPhoto[] {
  return (previews ?? []).map(preview => ({ preview, file: null }))
}

/** Previews for rendering and for the (non-durable) photoUrls field. */
export function toPreviews(current: readonly SelectedPhoto[]): string[] {
  return current.map(p => p.preview)
}

/**
 * The files to upload — only entries that actually carry bytes.
 *
 * Draft-restored entries are excluded: they are already on file or never were,
 * and re-uploading a preview string is not possible in any case.
 */
export function toUploadFiles(current: readonly SelectedPhoto[]): File[] {
  return current.map(p => p.file).filter((f): f is File => f !== null)
}

import type { BuyerPackDownloadRecord } from './buyerPackDownloads'

// Append-only audit trail for buyer pack lifecycle events. Backed by
// localStorage for this pass (same convention as lib/procurementControl.ts).
// Entries are never edited or removed once appended — appendBuyerPackAuditEvent
// is the only write operation this module exposes.
//
// Kept independent of buyerPackSnapshot.ts and buyerPackDownloads.ts at
// runtime (only type-only references, erased at compile time) so each module
// stays separately testable with no hidden cross-module coupling.

export type BuyerPackAuditAction = 'pack_generated' | 'pack_viewed' | 'pack_superseded' | 'pack_archived'

export interface BuyerPackAuditEvent {
  eventId: string
  packId: string
  snapshotVersion: number
  action: BuyerPackAuditAction
  timestamp: string
  user: string
}

const STORAGE_KEY = 'ddp_buyer_pack_audit_trail'

type AuditByPackId = Record<string, BuyerPackAuditEvent[]>

function readAll(): AuditByPackId {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(all: AuditByPackId): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function appendBuyerPackAuditEvent(input: {
  packId: string
  snapshotVersion: number
  action: BuyerPackAuditAction
  user: string
}): BuyerPackAuditEvent {
  const event: BuyerPackAuditEvent = Object.freeze({
    eventId: crypto.randomUUID(),
    packId: input.packId,
    snapshotVersion: input.snapshotVersion,
    action: input.action,
    timestamp: new Date().toISOString(),
    user: input.user,
  })

  const all = readAll()
  const existing = all[input.packId] ?? []
  all[input.packId] = [...existing, event]
  writeAll(all)

  return event
}

/** Chronological (oldest first) audit trail for one pack. Never mutated. */
export function getBuyerPackAuditTrail(packId: string): BuyerPackAuditEvent[] {
  return [...(readAll()[packId] ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

export interface BuyerPackHistoryEntry {
  timestamp: string
  user: string
  snapshotVersion: number
  kind: 'audit' | 'download'
  action: BuyerPackAuditAction | 'pack_downloaded'
  detail?: string
}

/**
 * Merges an audit trail and a download history (fetched separately by the
 * caller) into one chronological view. Takes both as plain parameters rather
 * than importing buyerPackDownloads.ts's read functions, so this module has
 * no runtime dependency on that one.
 */
export function mergeBuyerPackHistory(
  auditEvents: BuyerPackAuditEvent[],
  downloadRecords: BuyerPackDownloadRecord[],
): BuyerPackHistoryEntry[] {
  const fromAudit: BuyerPackHistoryEntry[] = auditEvents.map(e => ({
    timestamp: e.timestamp,
    user: e.user,
    snapshotVersion: e.snapshotVersion,
    kind: 'audit',
    action: e.action,
  }))

  const fromDownloads: BuyerPackHistoryEntry[] = downloadRecords.map(d => ({
    timestamp: d.timestamp,
    user: d.user,
    snapshotVersion: d.snapshotVersion,
    kind: 'download',
    action: 'pack_downloaded',
    detail: d.format,
  }))

  return [...fromAudit, ...fromDownloads].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

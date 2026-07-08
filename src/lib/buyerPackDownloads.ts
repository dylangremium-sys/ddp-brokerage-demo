// Append-only download history for buyer pack snapshots. Kept as its own
// dataset, separate from buyerPackAudit.ts's lifecycle audit trail — matching
// this codebase's own precedent (compliance_audit_log is a dedicated table,
// separate from other event types) and keeping "every download of this pack"
// a direct query against its own store rather than a filter over a general
// log. Backed by localStorage for this pass, same convention as the other
// buyer pack modules.
//
// Most fields beyond the core four are optional today and designed for
// future expansion — not every download context can populate them yet.

export interface BuyerPackDownloadRecord {
  downloadId: string
  packId: string
  snapshotVersion: number
  timestamp: string
  user: string
  format: string
  buyerOrganisation?: string
  browser?: string
  ipAddress?: string
  device?: string
  reason?: string
}

const STORAGE_KEY = 'ddp_buyer_pack_download_history'

type DownloadsByPackId = Record<string, BuyerPackDownloadRecord[]>

function readAll(): DownloadsByPackId {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(all: DownloadsByPackId): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function appendBuyerPackDownload(input: {
  packId: string
  snapshotVersion: number
  user: string
  format: string
  buyerOrganisation?: string
  browser?: string
  ipAddress?: string
  device?: string
  reason?: string
}): BuyerPackDownloadRecord {
  const record: BuyerPackDownloadRecord = Object.freeze({
    downloadId: crypto.randomUUID(),
    packId: input.packId,
    snapshotVersion: input.snapshotVersion,
    timestamp: new Date().toISOString(),
    user: input.user,
    format: input.format,
    buyerOrganisation: input.buyerOrganisation,
    browser: input.browser,
    ipAddress: input.ipAddress,
    device: input.device,
    reason: input.reason,
  })

  const all = readAll()
  const existing = all[input.packId] ?? []
  all[input.packId] = [...existing, record]
  writeAll(all)

  return record
}

/** Chronological (oldest first) download history for one pack. Never mutated. */
export function getBuyerPackDownloadHistory(packId: string): BuyerPackDownloadRecord[] {
  return [...(readAll()[packId] ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

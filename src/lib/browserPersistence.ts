// ─── Browser persistence policy ─────────────────────────────────────────────
//
// In DEMO mode (no Supabase), localStorage IS the database: it must keep working
// exactly as before. In SUPABASE mode the database is the system of record, and
// the browser must not hold a copy of production supply data.
//
// It did. `persistInventory`/`persistFarms` were write-through on every React
// state change (db.ts, App.tsx:117-118) with no environment check, so every farm
// profile and inventory batch an admin loaded in production was mirrored into
// localStorage — unencrypted, on the operator's machine, and left there after
// sign-out. The read path was already guarded (data.ts loadInventory/loadFarms
// return [] when Supabase is configured); only the write path was not. This module
// closes that asymmetry and gives sign-out a way to clear what is already there.

import { isSupabaseConfigured } from './supabase'

/**
 * May application data be written to browser storage?
 *
 * Demo mode  → YES: localStorage is the store.
 * Supabase   → NO:  the database is the store; the browser keeps no copy.
 *
 * The parameter exists for testing; production callers pass nothing.
 */
export function shouldPersistToBrowser(supabaseConfigured: boolean = isSupabaseConfigured): boolean {
  return !supabaseConfigured
}

/**
 * Every DDP-owned browser key holding application state. This is an ALLOWLIST:
 * sign-out removes exactly these and nothing else, so unrelated preferences (and
 * any key owned by another app on the same origin) survive. `localStorage.clear()`
 * is deliberately NOT used.
 *
 * A drift guard (scripts/sensitive-storage-registry.test.mjs) fails the build if a
 * new 'ddp_*' key is introduced in src/ and not listed here — otherwise a future
 * key would silently escape sign-out.
 */
export const SENSITIVE_DDP_KEYS: readonly string[] = [
  // Core supply data (data.ts)
  'ddp_inventory',
  'ddp_farms',
  'ddp_farm_draft',
  'ddp_review_requests',
  'ddp_market_benchmarks',
  // Procurement control (procurementControl.ts) — includes release decisions
  'ddp_procurement_decisions',
  'ddp_risk_overrides',
  'ddp_requirement_overrides',
  // Buyer Pack evidence (buyerPackSnapshotStore / buyerPackAudit / buyerPackDownloads)
  'ddp_buyer_pack_snapshots',
  'ddp_buyer_pack_audit_trail',
  'ddp_buyer_pack_download_history',
  // Compliance Watchtower (DDPComplianceWatchtower.tsx, complianceMonitoringSnapshotStore.ts)
  'ddp_compliance_legal_updates',
  'ddp_compliance_reviews',
  'ddp_compliance_rules',
  'ddp_compliance_alerts',
  'ddp_compliance_audit_log',
  'ddp_compliance_regulatory_sources',
  'ddp_compliance_monitoring_snapshots',
  'ddp_compliance_monitoring_baselines',
]

interface StorageLike {
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

function storages(): StorageLike[] {
  const found: StorageLike[] = []
  try { if (typeof localStorage !== 'undefined') found.push(localStorage) } catch { /* storage blocked */ }
  try { if (typeof sessionStorage !== 'undefined') found.push(sessionStorage) } catch { /* storage blocked */ }
  return found
}

/**
 * Removes every sensitive DDP key from local AND session storage.
 *
 * Called on sign-out. Previously sign-out cleared nothing, so a signed-out
 * browser still held the inventory, farm profiles and procurement decisions of
 * the previous operator — readable from devtools by whoever used the machine next.
 *
 * Failure to remove one key must not prevent the others from being removed, so
 * each removal is individually guarded. Returns the keys it actually cleared.
 */
export function clearSensitiveDdpStorage(target: StorageLike[] = storages()): string[] {
  const cleared: string[] = []
  for (const store of target) {
    for (const key of SENSITIVE_DDP_KEYS) {
      try {
        store.removeItem(key)
        cleared.push(key)
      } catch {
        // A single failed removal must not abort the rest of the sweep.
      }
    }
  }
  return cleared
}

/**
 * Writes to storage without ever throwing.
 *
 * The persist effects (App.tsx:117-119) call this on every state change. A
 * QuotaExceededError — realistic when a whole dataset is written repeatedly — would
 * otherwise propagate out of a useEffect, and there is no error boundary in the app,
 * so it would blank the UI.
 *
 * Returns TRUE only when the write actually succeeded. It never reports success it
 * did not achieve: a caller that needs to know whether data was persisted gets the
 * truth, rather than a silent false assurance.
 */
export function safeSetItem(key: string, value: string, store?: StorageLike): boolean {
  const target = store ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!target) return false
  try {
    target.setItem(key, value)
    return true
  } catch {
    return false
  }
}

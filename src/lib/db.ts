/**
 * Data layer — wraps localStorage with optional Supabase writes.
 *
 * When VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set, mutating operations
 * (create / update) are mirrored to Supabase after updating localStorage.
 * Reads always come from localStorage so the UI stays synchronous and instant.
 *
 * To fully switch reads to Supabase in a future iteration, replace the
 * localStorage calls in getFarmProfiles() and getInventoryBatches() with
 * Supabase selects and add a loading state in App.tsx.
 */

import { supabase, isSupabaseConfigured } from './supabase'
import {
  loadInventory as lsLoadInventory,
  saveInventory as lsSaveInventory,
  loadFarms as lsLoadFarms,
  saveFarms as lsSaveFarms,
  resetDemo as lsResetDemo,
} from '../data'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus } from '../types'

export { isSupabaseConfigured }

// ---------------------------------------------------------------------------
// Farm Profiles
// ---------------------------------------------------------------------------

export function getFarmProfiles(): FarmProfile[] {
  return lsLoadFarms()
}

export async function createFarmProfile(farm: FarmProfile): Promise<void> {
  const existing = lsLoadFarms()
  lsSaveFarms([farm, ...existing.filter(f => f.id !== farm.id)])
  if (!supabase) return
  await supabase.from('farms').upsert({
    id: farm.id,
    farm_name: farm.tradingName,
    legal_business_name: farm.legalBusinessName,
    trading_name: farm.tradingName,
    province: farm.province,
    district: farm.district,
    gps_coordinates: farm.gpsCoordinates,
    primary_contact: farm.primaryContact,
    mobile_number: farm.mobileNumber,
    email: farm.email,
    status: farm.status,
    completion_percentage: farm.completionPct,
    compliance_status: null,
    export_readiness: null,
    risk_level: null,
    partner_tier: farm.partnerTier,
  })
}

export async function updateFarmProfileStatus(farmId: string, status: FarmStatus): Promise<void> {
  if (!supabase) return
  await supabase.from('farms').update({ status }).eq('id', farmId)
}

// ---------------------------------------------------------------------------
// Inventory Batches
// ---------------------------------------------------------------------------

export function getInventoryBatches(): InventoryItem[] {
  return lsLoadInventory()
}

export async function createInventoryBatch(item: InventoryItem): Promise<void> {
  const existing = lsLoadInventory()
  lsSaveInventory([item, ...existing.filter(i => i.id !== item.id)])
  if (!supabase) return
  await supabase.from('inventory_batches').upsert({
    id: item.id,
    farm_id: item.farmId ?? null,
    product_name: item.productName,
    strain: item.productName,
    location: item.location,
    quantity_kg: item.quantityKg,
    harvest_date: item.harvestDate,
    cure_date: item.cureDate,
    batch_number: item.batchNumber,
    thc_percent: item.thcPct,
    cbd_percent: item.cbdPct,
    moisture_percent: item.moisturePct,
    water_activity: parseFloat(item.waterActivity) || null,
    quality_grade: item.qualityGrade,
    price_per_kg: item.pricePerKg,
    coa_file_name: item.certFileName,
    photo_url: item.photoUrl || null,
    storage_conditions: item.storageConditions,
    notes: item.notes || null,
    status: item.status,
  })
}

export async function updateInventoryStatus(itemId: string, status: InventoryStatus): Promise<void> {
  if (!supabase) return
  await supabase.from('inventory_batches').update({ status }).eq('id', itemId)
}

export function getApprovedInventory(): InventoryItem[] {
  return lsLoadInventory().filter(i => i.status === 'Approved')
}

// ---------------------------------------------------------------------------
// Persist helpers — called by App.tsx useEffects on every state change.
// These keep localStorage in sync as the primary write-through cache.
// ---------------------------------------------------------------------------

export function persistInventory(items: InventoryItem[]): void {
  lsSaveInventory(items)
}

export function persistFarms(farms: FarmProfile[]): void {
  lsSaveFarms(farms)
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export async function resetDemoData(): Promise<void> {
  lsResetDemo()
  // Full Supabase reset requires a server-side function; localStorage reset
  // is sufficient for demo purposes.
}

import { supabase, isSupabaseConfigured } from './supabase'
import { shouldPersistToBrowser } from './browserPersistence'
import { sha256Hex } from './sha256'
import {
  loadInventory as lsLoadInventory,
  saveInventory as lsSaveInventory,
  loadFarms as lsLoadFarms,
  saveFarms as lsSaveFarms,
  resetDemo as lsResetDemo,
} from '../data'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark, StockStatus, ProductType, TestStatus, StoredPhoto, BatchPhotoType, BatchPriceCurrency, FarmerDocument, FarmerDocumentType, DocumentReviewStatus } from '../types'
import { BATCH_PRICE_CURRENCIES, DEFAULT_BATCH_PRICE_CURRENCY } from '../types'

export { isSupabaseConfigured }

/**
 * An empty or whitespace-only string is the absence of a value, and must reach
 * Postgres as NULL rather than ''.
 *
 * The form's text inputs are '' until touched, and several of the columns they
 * feed refuse a blank outright: a `date` column rejects ''::date with 22007,
 * and `batch_number` carries a not-blank CHECK. Coercing here — at the single
 * payload boundary — rather than at each callsite means a field added to the
 * form later cannot reintroduce the defect by forgetting to do it.
 */
function nullIfBlank(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ---------------------------------------------------------------------------
// UUID guard — seed farms use 'farm-1' style IDs that are not valid UUIDs.
// Supabase UUID columns reject them. Skip Supabase writes for these IDs and
// warn loudly so the developer knows what happened.
// ---------------------------------------------------------------------------
function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

// ---------------------------------------------------------------------------
// Low-level Supabase helpers — always check { error } and throw on failure.
// Supabase JS client never throws; every error is returned in the response.
// ---------------------------------------------------------------------------
async function sbInsert(table: string, data: Record<string, unknown>): Promise<void> {
  const { error } = await supabase!.from(table).insert(data)
  if (error) {
    console.error(`Supabase error [${table} insert]:`, error)
    throw new Error(error.message)
  }
}

async function sbUpsert(table: string, data: Record<string, unknown>): Promise<void> {
  const { error } = await supabase!.from(table).upsert(data)
  if (error) {
    console.error(`Supabase error [${table} upsert]:`, error)
    throw new Error(error.message)
  }
}

async function sbUpdate(
  table: string,
  data: Record<string, unknown>,
  matchCol: string,
  matchVal: string,
): Promise<void> {
  const { error } = await supabase!.from(table).update(data).eq(matchCol, matchVal)
  if (error) {
    console.error(`Supabase error [${table} update]:`, error)
    throw new Error(error.message)
  }
}

async function sbUpsertOn(table: string, data: Record<string, unknown>, onConflict: string): Promise<void> {
  const { error } = await supabase!.from(table).upsert(data, { onConflict })
  if (error) {
    console.error(`Supabase error [${table} upsert on ${onConflict}]:`, error)
    throw new Error(error.message)
  }
}

async function sbUpsertIgnore(table: string, data: Record<string, unknown>, onConflict: string): Promise<void> {
  const { error } = await supabase!.from(table).upsert(data, { onConflict, ignoreDuplicates: true })
  if (error) {
    console.error(`Supabase error [${table} upsert ignore on ${onConflict}]:`, error)
    throw new Error(error.message)
  }
}

// ---------------------------------------------------------------------------
// Atomic status transitions (migration 35 — audit R7)
//
// A status change is TWO writes: the entity row moves to the new status, and a
// status_history row records that it did. Performed as two independent PostgREST
// calls they are not atomic, and because sbInsert throws on any error, a failed
// history insert reports FAILURE to the operator while the row is ALREADY at the
// new status. status_history is the compliance artefact, so the result is a
// silent divergence between the state and the record of how it was reached.
//
// public.record_status_transition() does both inside one transaction. It is
// preferred whenever it is deployed, with the legacy two-call path kept only for
// the window in which it is not.
// ---------------------------------------------------------------------------

const STATUS_TRANSITION_RPC = 'record_status_transition'

/**
 * PostgREST's code for "this FUNCTION is not in the schema cache".
 *
 * NOT PGRST205 — that is the code for a missing TABLE. Verified directly against
 * production on 2026-07-28:
 *
 *   POST /rest/v1/rpc/record_status_transition -> {"code":"PGRST202", ...
 *       "Could not find the function public.record_status_transition ..."}
 *   GET  /rest/v1/risk_overrides               -> {"code":"PGRST205", ...
 *       "Could not find the table 'public.risk_overrides' ..."}
 *
 * Matching on the table code here would mean the fallback below never fires, and
 * every status transition would fail for as long as migration 35 is unapplied.
 */
const MISSING_FUNCTION_PGRST = 'PGRST202'

/** Postgres `undefined_function` — the direct-connection equivalent. */
const UNDEFINED_FUNCTION = '42883'

/** The only object whose absence may legitimately degrade to the legacy path. */
const STATUS_RPC_OBJECT = /record_status_transition/i

/**
 * True ONLY when the transition RPC itself is not deployed. That is "migration 35
 * has not been applied yet" and may fall back to the pre-existing two-call path.
 *
 * Everything else — 42501 (the caller is not an administrator), 42703 (schema
 * drift), 22023 (a rejected argument), authentication failure, a transient 5xx,
 * a network error — is an AUTHORITATIVE FAILURE and must surface as one. Falling
 * back on a permission denial would silently retry the write through a path with
 * weaker checks, which is precisely the hole the RPC exists to close.
 *
 * Both the 42883 branch and the codeless branch are deliberately narrow: they
 * apply only when the message NAMES this function, so a generic
 * "... does not exist" can never be mistaken for a missing RPC. Same shape as
 * procurementDecisionStore.ts isTableMissing().
 */
function isStatusTransitionRpcMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const message = error.message ?? ''

  // PGRST202 is raised by PostgREST itself, before any SQL runs, and can only
  // ever refer to the function being invoked. It is unambiguous on its own.
  if (error.code === MISSING_FUNCTION_PGRST) return true

  // 42883 is `undefined_function`, raised by Postgres for ANY missing function —
  // including one called from INSIDE a deployed record_status_transition (say, by
  // a trigger on the status_history insert). Treating that as "not deployed"
  // would retry through the non-atomic path, where the entity UPDATE can commit
  // without its audit record — recreating audit finding R7, which this function
  // exists to prevent. So require the message to name the RPC, exactly as the
  // codeless branch does. A genuinely absent RPC always names itself here
  // ("function public.record_status_transition(...) does not exist").
  if (error.code === UNDEFINED_FUNCTION) return STATUS_RPC_OBJECT.test(message)

  // Any other code is an authoritative failure.
  if (error.code) return false

  return /could not find the function|does not exist|schema cache/i.test(message) && STATUS_RPC_OBJECT.test(message)
}

/**
 * Attempts the atomic transition.
 *
 * Returns true when the RPC performed both writes. Returns false ONLY when the
 * RPC is not deployed, which tells the caller to use the legacy path. Throws on
 * every other error.
 */
async function tryAtomicStatusTransition(
  entityType: 'farm' | 'inventory_batch',
  entityId: string,
  newStatus: string,
  oldStatus?: string,
  reviewerId?: string,
): Promise<boolean> {
  // skipcq: JS-0339 — `supabase!` is the established idiom throughout this file
  // (five pre-existing uses on main; this is the sixth in the same shape). Every
  // caller returns early on `if (!supabase)` before reaching here, asserted by
  // the test "demo mode (no Supabase client) performs no write at all".
  // Converting all six is a repo-wide refactor, not this PR's subject.
  const { error } = await supabase!.rpc(STATUS_TRANSITION_RPC, {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_new_status: newStatus,
    // Advisory only. The function reads the real previous status from the row
    // under lock and records that instead — an audit record must state what was
    // true, not what a possibly-stale browser believed.
    p_old_status: oldStatus ?? null,
    // The function requires this to equal auth.uid() when present, so a
    // transition can never be attributed to another administrator.
    p_reviewer_id: reviewerId && isValidUUID(reviewerId) ? reviewerId : null,
  })

  if (!error) return true

  if (isStatusTransitionRpcMissing(error)) {
    console.warn(
      `${STATUS_TRANSITION_RPC}: not deployed (${error.code ?? 'no code'}) — falling back to the ` +
      'non-atomic two-call path. Apply migration 35 to close audit finding R7.',
    )
    return false
  }

  console.error(`Supabase error [${STATUS_TRANSITION_RPC}]:`, error)
  throw new Error(error.message)
}

// ---------------------------------------------------------------------------
// Farm Profiles
// ---------------------------------------------------------------------------

export function getFarmProfiles(): FarmProfile[] {
  return lsLoadFarms()
}

export async function createFarmProfile(farm: FarmProfile, userId?: string): Promise<void> {
  // DEMO MODE ONLY. In Supabase mode the database is the system of record and the
  // browser must not hold a copy of a real farm profile — see browserPersistence.ts.
  if (shouldPersistToBrowser()) {
    const existing = lsLoadFarms()
    lsSaveFarms([farm, ...existing.filter(f => f.id !== farm.id)])
  }

  if (!supabase) return

  if (!isValidUUID(farm.id)) {
    console.warn(`createFarmProfile: skipping Supabase write — "${farm.id}" is not a valid UUID`)
    return
  }

  console.log('Creating farm in Supabase', { id: farm.id, tradingName: farm.tradingName })

  // 1. farms row (flat columns used for list views and filtering)
  await sbUpsert('farms', {
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
    created_by: userId ?? null,
    updated_at: new Date().toISOString(),
  })

  console.log('Created farm id:', farm.id)

  // 2. farm_memberships — link the creating user as farm owner.
  //
  // THIS MUST COME BEFORE THE farm_profiles WRITE, AND THE ORDER IS THE WHOLE BUG.
  //
  // farm_profiles is written with an UPSERT (`ON CONFLICT`). Under row level
  // security PostgreSQL evaluates the UPDATE policy for a statement carrying an
  // ON CONFLICT clause — not just the INSERT policy — and
  // `farm_profiles: farmer update own` requires a row in farm_memberships:
  //
  //     EXISTS (SELECT 1 FROM farm_memberships fm
  //              WHERE fm.farm_id = farm_profiles.farm_id AND fm.user_id = auth.uid())
  //
  // With the membership created afterwards, that row never exists at the moment
  // it is needed, so the upsert fails with 42501 "new row violates row-level
  // security policy", createFarmProfile throws, and the membership write below
  // is never reached. The farmer is then permanently stuck: every retry fails
  // identically, because the thing that would unblock it only runs after the
  // step that always fails.
  //
  // Measured against production 2026-08-02, impersonating a real farmer:
  //   plain INSERT into farm_profiles            -> succeeds
  //   INSERT ... ON CONFLICT (what this code does) -> 42501
  //   same upsert with the membership created first -> succeeds
  //
  // The visible damage was not an error message. The farms row (step 1) lands,
  // so a farm APPEARS in the admin queue with its flat fields populated, while
  // every JSONB section — ownership, licences, facility, cultivation, strains,
  // lab testing — stays empty forever. The compliance score reads 0/900 off
  // those empty sections and the farm looks non-compliant rather than unsaved.
  //
  // Reordering needs no migration: the policies are correct, the sequence was not.
  if (userId && isValidUUID(userId)) {
    await sbUpsertIgnore('farm_memberships', {
      farm_id: farm.id,
      user_id: userId,
      role: 'owner',
    }, 'farm_id,user_id')
  }

  console.log('Creating farm_profile for farm id:', farm.id)

  // 3. farm_profiles row (full profile data split into JSONB sections)
  await sbUpsertOn('farm_profiles', {
    farm_id: farm.id,
    business_info: {
      legalBusinessName: farm.legalBusinessName,
      tradingName: farm.tradingName,
      registrationNumber: farm.registrationNumber,
      taxNumber: farm.taxNumber,
      dateEstablished: farm.dateEstablished,
      province: farm.province,
      district: farm.district,
      gpsCoordinates: farm.gpsCoordinates,
      registeredAddress: farm.registeredAddress,
      operationalAddress: farm.operationalAddress,
      website: farm.website,
      facebook: farm.facebook,
      lineId: farm.lineId,
      whatsapp: farm.whatsapp,
      email: farm.email,
      primaryContact: farm.primaryContact,
      position: farm.position,
      mobileNumber: farm.mobileNumber,
      secondaryContact: farm.secondaryContact,
      emergencyContact: farm.emergencyContact,
    },
    ownership: {
      ownerName: farm.ownerName,
      nationality: farm.nationality,
      ownershipPct: farm.ownershipPct,
      additionalShareholders: farm.additionalShareholders,
      ownershipBreakdown: farm.ownershipBreakdown,
      ultimateBeneficialOwners: farm.ultimateBeneficialOwners,
      parentCompany: farm.parentCompany,
      subsidiaries: farm.subsidiaries,
      foreignInvestors: farm.foreignInvestors,
      strategicPartners: farm.strategicPartners,
      exportPartners: farm.exportPartners,
    },
    licenses: {
      cultivationLicence: farm.cultivationLicence,
      processingLicence: farm.processingLicence,
      manufacturingLicence: farm.manufacturingLicence,
      researchLicence: farm.researchLicence,
      medicalCannabisLicence: farm.medicalCannabisLicence,
      exportLicence: farm.exportLicence,
      importLicence: farm.importLicence,
      gmpCert: farm.gmpCert,
      gapCert: farm.gapCert,
      gacpCert: farm.gacpCert,
      picsCert: farm.picsCert,
      organicCert: farm.organicCert,
      isoCerts: farm.isoCerts,
      otherCerts: farm.otherCerts,
      documentExpiry: farm.documentExpiry,
    },
    facility: {
      farmType: farm.farmType,
      totalLandArea: farm.totalLandArea,
      cultivationArea: farm.cultivationArea,
      floweringArea: farm.floweringArea,
      nurseryArea: farm.nurseryArea,
      motherPlantArea: farm.motherPlantArea,
      processingArea: farm.processingArea,
      dryingArea: farm.dryingArea,
      storageArea: farm.storageArea,
      securityArea: farm.securityArea,
      expansionCapacity: farm.expansionCapacity,
      facilityPhotoUrl: farm.facilityPhotoUrl,
    },
    cultivation: {
      activeRooms: farm.activeRooms,
      harvestsPerYear: farm.harvestsPerYear,
      avgYieldPerHarvest: farm.avgYieldPerHarvest,
      annualCapacity: farm.annualCapacity,
      currentInventory: farm.currentInventory,
      projectedInventory: farm.projectedInventory,
      productionUtilisation: farm.productionUtilisation,
      maxProductionCapacity: farm.maxProductionCapacity,
      cultivationMethod: farm.cultivationMethod,
      fertiliserProgram: farm.fertiliserProgram,
      nutrientBrands: farm.nutrientBrands,
      pestManagement: farm.pestManagement,
      ipmProcedures: farm.ipmProcedures,
      waterSource: farm.waterSource,
      waterTestingFrequency: farm.waterTestingFrequency,
      waterAnalysisFile: farm.waterAnalysisFile,
    },
    strains: {
      mainStrains: farm.mainStrains,
      breeder: farm.breeder,
      geneticLineage: farm.geneticLineage,
      typicalThc: farm.typicalThc,
      typicalCbd: farm.typicalCbd,
      dominantTerpenes: farm.dominantTerpenes,
      harvestCycle: farm.harvestCycle,
      yieldPerSqm: farm.yieldPerSqm,
      qtyAvailableNow: farm.qtyAvailableNow,
      qtyAvailable30: farm.qtyAvailable30,
      qtyAvailable60: farm.qtyAvailable60,
      qtyAvailable90: farm.qtyAvailable90,
      qtyAvailable180: farm.qtyAvailable180,
      productPhotoUrl: farm.productPhotoUrl,
    },
    lab_testing: {
      coaFiles: farm.coaFiles,
      heavyMetalsTested: farm.heavyMetalsTested,
      pesticidesTested: farm.pesticidesTested,
      mycotoxinsTested: farm.mycotoxinsTested,
      microbiologyTested: farm.microbiologyTested,
      waterActivityTested: farm.waterActivityTested,
      batchTrackingSystem: farm.batchTrackingSystem,
      seedToSaleSystem: farm.seedToSaleSystem,
      sopsAvailable: farm.sopsAvailable,
      recallProcedure: farm.recallProcedure,
      wasteDisposal: farm.wasteDisposal,
      employeeTraining: farm.employeeTraining,
      securityProtocols: farm.securityProtocols,
      visitorProcedures: farm.visitorProcedures,
      incidentReporting: farm.incidentReporting,
      capaProgram: farm.capaProgram,
      internalAudits: farm.internalAudits,
      externalAudits: farm.externalAudits,
    },
    export_readiness_data: {
      suppliedEU: farm.suppliedEU,
      suppliedPharma: farm.suppliedPharma,
      suppliedGMPProcessors: farm.suppliedGMPProcessors,
      existingSopLibrary: farm.existingSopLibrary,
      existingQA: farm.existingQA,
      existingQC: farm.existingQC,
      qualifiedPerson: farm.qualifiedPerson,
      stabilityProgram: farm.stabilityProgram,
      changeControl: farm.changeControl,
      deviationProcedures: farm.deviationProcedures,
      riskManagement: farm.riskManagement,
      documentationControl: farm.documentationControl,
      countriesExported: farm.countriesExported,
      freightProviders: farm.freightProviders,
      customsBrokers: farm.customsBrokers,
      incotermsFamiliarity: farm.incotermsFamiliarity,
      packagingStandards: farm.packagingStandards,
      labellingStandards: farm.labellingStandards,
      shippingCapacity: farm.shippingCapacity,
      interestedExclusive: farm.interestedExclusive,
      interestedNonExclusive: farm.interestedNonExclusive,
      interestedEUGMP: farm.interestedEUGMP,
      interestedLongTerm: farm.interestedLongTerm,
      interestedJV: farm.interestedJV,
    },
    monthly_reporting: {
      monthlyReportingAgreement: farm.monthlyReportingAgreement,
    },
    updated_at: new Date().toISOString(),
  }, 'farm_id')

  // The farm_memberships write used to sit HERE, after farm_profiles. See the
  // comment at step 2 for why that ordering could never work.
}

export async function updateFarmProfileStatus(
  farmId: string,
  newStatus: FarmStatus,
  oldStatus?: FarmStatus,
  reviewerId?: string,
): Promise<void> {
  if (!supabase) return

  if (!isValidUUID(farmId)) {
    console.warn(`updateFarmProfileStatus: skipping Supabase write — "${farmId}" is not a valid UUID (seed data)`)
    return
  }

  // Preferred: one transaction, so the row change and its audit record either
  // both land or neither does.
  if (await tryAtomicStatusTransition('farm', farmId, newStatus, oldStatus, reviewerId)) return

  // LEGACY, NON-ATOMIC path — reached only while migration 35 is unapplied.
  // If the history insert below fails, the farm row is already at the new status
  // and the operator is nonetheless shown a failure. That is audit finding R7,
  // and it is why the RPC above exists.
  const farmUpdate: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() }
  if (reviewerId && isValidUUID(reviewerId)) farmUpdate.reviewed_by = reviewerId
  await sbUpdate('farms', farmUpdate, 'id', farmId)

  await sbInsert('status_history', {
    entity_type: 'farm',
    entity_id: farmId,
    old_status: oldStatus ?? null,
    new_status: newStatus,
    note: reviewerId ? `Reviewed by ${reviewerId}` : null,
  })
}

// ---------------------------------------------------------------------------
// Inventory Batches
// ---------------------------------------------------------------------------

export function getInventoryBatches(): InventoryItem[] {
  return lsLoadInventory()
}

export async function createInventoryBatch(item: InventoryItem, userId?: string): Promise<void> {
  // DEMO MODE ONLY — as above. A real inventory batch must not be mirrored into
  // the operator's browser when Supabase is the system of record.
  if (shouldPersistToBrowser()) {
    const existing = lsLoadInventory()
    lsSaveInventory([item, ...existing.filter(i => i.id !== item.id)])
  }

  if (!supabase) return

  if (!isValidUUID(item.id)) {
    console.warn(`createInventoryBatch: skipping Supabase write — "${item.id}" is not a valid UUID`)
    return
  }

  console.log('Creating inventory batch in Supabase', { id: item.id, productName: item.productName })

  // Filter out data URLs — they can be 500 KB+ and don't belong in the DB.
  //
  // This filter used to be where farmer photos SILENTLY DIED: every attached
  // photo is a data: URL, nothing uploaded them anywhere, and no warning was
  // shown. The durable path now exists — uploadBatchPhoto + recordBatchPhoto
  // put the bytes in the private farmer-photos bucket and the path in
  // public.farmer_photos — and the caller runs it after this row is committed.
  // So dropping the previews here is now correct rather than lossy.
  const storablePhotoUrls = (item.photoUrls ?? []).filter(u => !u.startsWith('data:'))

  await sbUpsert('inventory_batches', {
    id: item.id,
    farm_id: item.farmId && isValidUUID(item.farmId) ? item.farmId : null,
    product_name: item.productName,
    strain: item.productName,
    location: item.location,
    quantity_kg: item.quantityKg,
    // These three are `string` on InventoryItem and the form leaves them '' when
    // untouched. Postgres refuses all three: '' fails the ::date cast on the two
    // date columns, and batch_number carries a live not-blank CHECK. A blank is
    // the absence of a value, so it is sent as NULL.
    harvest_date: nullIfBlank(item.harvestDate),
    cure_date: nullIfBlank(item.cureDate),
    batch_number: nullIfBlank(item.batchNumber),
    thc_percent: item.thcPct,
    cbd_percent: item.cbdPct,
    moisture_percent: item.moisturePct,
    water_activity: parseFloat(item.waterActivity) || null,
    quality_grade: item.qualityGrade,
    price_per_kg: item.pricePerKg,
    // Production refuses a priced row that does not state its currency
    // (inventory_batches_price_requires_currency). The application states it
    // explicitly rather than relying on a column default: a default would make
    // the currency an assumption of the database's, silently applied to a
    // future non-THB listing, instead of a fact the submitting client asserts.
    price_currency: item.priceCurrency ?? DEFAULT_BATCH_PRICE_CURRENCY,
    coa_file_name: item.certFileName || null,
    photo_url: item.photoUrl || null,
    storage_conditions: item.storageConditions,
    notes: item.notes || null,
    status: item.status,
    created_by: userId ?? null,
    updated_at: new Date().toISOString(),
    // New farmer-MVP fields
    stock_status: item.stockStatus ?? null,
    product_type: item.productType ?? null,
    unit: item.unit ?? 'kg',
    minimum_order_kg: item.minimumOrderKg ?? null,
    total_terpenes_pct: item.totalTerpenesPct ?? null,
    expiry_date: item.expiryDate ?? null,
    client_visible: item.clientVisible ?? false,
    coa_available: item.coaAvailable ?? false,
    lab_name: item.labName ?? null,
    report_number: item.reportNumber ?? null,
    sample_name: item.sampleName ?? null,
    test_date: item.testDate ?? null,
    heavy_metals_status: item.heavyMetalsStatus || null,
    pesticides_status: item.pesticidesStatus || null,
    microbial_status: item.microbialStatus || null,
    mycotoxins_status: item.mycotoxinsStatus || null,
    photo_urls: storablePhotoUrls.length > 0 ? storablePhotoUrls : null,
    coa_storage_path: item.coaStoragePath ?? null,
    farmer_notes: item.farmerNotes ?? null,
    // ownerNotes is deliberately NOT written here. Migration 57 moved DDP's
    // internal note to batch_internal_notes, which only a ddp_admin can touch;
    // this path runs as the farmer creating the batch.
  })
}

export async function updateInventoryStatus(
  itemId: string,
  newStatus: InventoryStatus,
  oldStatus?: InventoryStatus,
  reviewerId?: string,
): Promise<void> {
  if (!supabase) return

  if (!isValidUUID(itemId)) {
    console.warn(`updateInventoryStatus: skipping Supabase write — "${itemId}" is not a valid UUID (seed data)`)
    return
  }

  // Preferred: one transaction — see updateFarmProfileStatus above.
  if (await tryAtomicStatusTransition('inventory_batch', itemId, newStatus, oldStatus, reviewerId)) return

  // LEGACY, NON-ATOMIC path — reached only while migration 35 is unapplied.
  const batchUpdate: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() }
  if (reviewerId && isValidUUID(reviewerId)) batchUpdate.reviewed_by = reviewerId
  await sbUpdate('inventory_batches', batchUpdate, 'id', itemId)

  await sbInsert('status_history', {
    entity_type: 'inventory_batch',
    entity_id: itemId,
    old_status: oldStatus ?? null,
    new_status: newStatus,
    note: reviewerId ? `Reviewed by ${reviewerId}` : null,
  })
}

// ---------------------------------------------------------------------------
// DDP's internal note about a batch.
//
// Lives in batch_internal_notes, not on the batch row, because a DDP admin and
// a farmer are the SAME PostgreSQL role (`authenticated`) — only a row-level
// policy can tell them apart, and a row-level policy needs its own row.
// Before migration 57 this was inventory_batches.owner_notes and every farmer
// could read their own batch's copy of it.
//
// No admin check here on purpose. The policy on batch_internal_notes is the
// control; a client-side check would be advice. A non-admin calling this gets
// nothing written and no row back.
//
// An empty note DELETES rather than storing '': the table refuses a blank note,
// and "cleared" and "never written" are the same state to every reader.
// ---------------------------------------------------------------------------
export async function saveBatchInternalNote(batchId: string, note: string): Promise<void> {
  if (!supabase) return
  if (!isValidUUID(batchId)) {
    console.warn(`saveBatchInternalNote: skipping — "${batchId}" is not a valid UUID`)
    return
  }

  const trimmed = note.trim()
  if (trimmed === '') {
    const { error } = await supabase.from('batch_internal_notes').delete().eq('batch_id', batchId)
    if (error) throw error
    return
  }

  const { data: session } = await supabase.auth.getUser()
  const { error } = await supabase.from('batch_internal_notes').upsert(
    { batch_id: batchId, note: trimmed, updated_by: session?.user?.id ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'batch_id' },
  )
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Patch an inventory batch — for admin actions (client_visible toggle) and
// farmer re-submissions (stock_status change). DDP's internal note is NOT here:
// migration 57 moved it to batch_internal_notes. See saveBatchInternalNote.
// ---------------------------------------------------------------------------
export async function patchInventoryBatch(
  itemId: string,
  fields: Partial<{
    stock_status: string
    client_visible: boolean
    status: InventoryStatus
    coa_file_name: string
    coa_available: boolean
    coa_storage_path: string
  }>,
): Promise<void> {
  if (!supabase) return
  if (!isValidUUID(itemId)) {
    console.warn(`patchInventoryBatch: skipping — "${itemId}" is not a valid UUID`)
    return
  }
  await sbUpdate(
    'inventory_batches',
    { ...fields, updated_at: new Date().toISOString() },
    'id',
    itemId,
  )
}

// ---------------------------------------------------------------------------
// Review requests (DDP → farmer change requests)
// ---------------------------------------------------------------------------

export async function createReviewRequest(
  req: Omit<ReviewRequest, 'id' | 'createdAt'>,
  adminUserId?: string,
): Promise<void> {
  if (!supabase) return
  if (req.stockItemId && !isValidUUID(req.stockItemId)) {
    console.warn('createReviewRequest: skipping — invalid UUID for stockItemId')
    return
  }
  await sbInsert('farmer_review_requests', {
    inventory_batch_id: req.stockItemId ?? null,
    farm_id: null,
    request_type: req.requestType,
    message: req.message,
    status: 'open',
    created_by: adminUserId && isValidUUID(adminUserId) ? adminUserId : null,
    product_name: req.productName ?? null,
    farm_name: req.farmName ?? null,
  })
}

export async function resolveReviewRequest(requestId: string): Promise<void> {
  if (!supabase) return
  if (!isValidUUID(requestId)) {
    console.warn('resolveReviewRequest: skipping — invalid UUID')
    return
  }
  await sbUpdate(
    'farmer_review_requests',
    { status: 'resolved', resolved_at: new Date().toISOString() },
    'id',
    requestId,
  )
}

function mapReviewRequestRow(row: Record<string, unknown>): ReviewRequest {
  return {
    id: row.id as string,
    stockItemId: row.inventory_batch_id as string | undefined,
    farmProfileId: row.farm_id as string | undefined,
    requestType: row.request_type as ReviewRequest['requestType'],
    message: row.message as string,
    status: row.status as 'open' | 'resolved',
    createdBy: row.created_by as string ?? 'DDP Admin',
    createdAt: row.created_at as string,
    resolvedAt: row.resolved_at as string | undefined,
    productName: row.product_name as string | undefined,
    farmName: row.farm_name as string | undefined,
  }
}

export async function loadReviewRequestsFromDB(
  userId: string,
  farmIds: Set<string>,
  itemIds: Set<string>,
): Promise<ReviewRequest[]> {
  if (!supabase || !isValidUUID(userId)) return []

  const batchIdList = [...itemIds].filter(isValidUUID)
  const farmIdList = [...farmIds].filter(isValidUUID)
  // Neither scope → nothing this farmer can own; skip the query entirely.
  if (batchIdList.length === 0 && farmIdList.length === 0) return []

  // A farmer owns a request by EITHER its inventory batch OR its farm. The
  // previous batch-only filter dropped farm-level requests (inventory_batch_id
  // null, farm_id set) and returned early whenever the farmer had no batches,
  // so those messages never reached the farmer's inbox even though RLS
  // ("farmer_review_requests: farmer select own") authorizes them. RLS remains
  // the server-side authority; this OR only narrows to the farmer's own scope.
  // Mirrors loadFarmerInventoryFromDB's batch-or-farm union. A row matching both
  // conditions is still returned once (OR yields distinct rows — no dedup).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any)
    .from('farmer_review_requests')
    .select('*')

  if (batchIdList.length > 0 && farmIdList.length > 0) {
    query = query.or(`inventory_batch_id.in.(${batchIdList.join(',')}),farm_id.in.(${farmIdList.join(',')})`)
  } else if (batchIdList.length > 0) {
    query = query.in('inventory_batch_id', batchIdList)
  } else {
    query = query.in('farm_id', farmIdList)
  }

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) {
    console.warn('loadReviewRequestsFromDB:', error.message)
    return []
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => mapReviewRequestRow(row))
}

// Read-only admin loader. Returns EVERY review request the caller may see; the
// `farmer_review_requests: admin all` RLS policy (USING is_ddp_admin()) scopes
// this to administrators server-side, so no client-side user/batch filter is
// applied. Unlike loadReviewRequestsFromDB it is not batch-scoped, so it also
// returns farm-level requests (inventory_batch_id IS NULL) and never depends on
// the admin having first loaded inventory. This performs NO write.
//
// A rejected promise (thrown below) — not a silent [] — signals a genuine load
// failure so the Operations Desk can report an unavailable source rather than a
// confirmed zero. (A query error is distinct from "loaded, and legitimately
// empty", which returns [].)
export async function loadAllReviewRequestsFromDB(): Promise<ReviewRequest[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .from('farmer_review_requests')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`loadAllReviewRequestsFromDB: ${error.message}`)
  }

  return (data ?? []).map(mapReviewRequestRow)
}

// ---------------------------------------------------------------------------
// Market benchmarks (DDP → farmer price hints)
// ---------------------------------------------------------------------------

export async function loadMarketBenchmarksFromDB(): Promise<MarketBenchmark[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .from('market_price_benchmarks')
    .select('*')
    .eq('visible_to_farmers', true)
    .order('product_type')

  // NEVER substitute the demo seed here. This runs only when Supabase IS
  // configured — i.e. in production, for a signed-in farmer — so returning
  // SEED_BENCHMARKS presented fictional prices as real market guidance, with no
  // badge and no warning, on nothing more than a transient query error or an
  // empty table. Empty is the honest answer; App.tsx already declines to
  // overwrite state with an empty result.
  if (error) {
    console.warn('loadMarketBenchmarksFromDB:', error.message)
    return []
  }

  if (!data || data.length === 0) return []

  return data.map(row => ({
    id: row.id as string,
    productType: row.product_type as string,
    thcRange: row.thc_range as string | undefined,
    priceMin: row.price_min as number,
    priceMax: row.price_max as number,
    unit: (row.unit ?? 'kg') as 'g' | 'kg',
    visibleToFarmers: true,
  }))
}

// ---------------------------------------------------------------------------
// COA file upload and signed URL helpers
// ---------------------------------------------------------------------------

// Upload a PDF COA for a specific inventory batch.
// Storage path: {userId}/{farmId}/{batchId}/{timestamp}-{safeFileName}.pdf
// The first segment (userId) satisfies the storage RLS policy:
//   auth.uid()::text = (string_to_array(name, '/'))[1]
export async function uploadCoaFile(
  file: File,
  userId: string,
  farmId: string,
  batchId: string,
): Promise<{ storagePath: string }> {
  if (!supabase) throw new Error('Supabase not configured')
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  const storagePath = `${userId}/${farmId}/${batchId}/${Date.now()}-${safeName}`
  const { error } = await supabase.storage
    .from('farmer-documents')
    .upload(storagePath, file, { contentType: 'application/pdf', upsert: false })
  if (error) throw new Error(`COA upload failed: ${error.message}`)
  return { storagePath }
}

/**
 * Fingerprint a file's bytes before they leave the browser.
 *
 * Hashed from the SAME File object that is handed to the uploader, so the digest
 * describes exactly what was sent. Hashing a re-read or a server-side copy would
 * prove only that two reads agreed, not that the stored bytes are the ones the
 * farmer chose.
 *
 * This is integrity-since-upload and nothing more. It does NOT establish that a
 * certificate is authentic or that the issuing laboratory produced it — a byte
 * hash cannot speak to origin. Claiming otherwise is the single easiest false
 * statement to make about this feature.
 */
export async function hashFileHex(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return sha256Hex(bytes)
}

/**
 * Record an uploaded COA in public.farmer_documents — the evidence register.
 *
 * The register, its sha256 index and its RLS have existed since migrations 15,
 * 22, 28 and 42. Nothing ever wrote to it: three files sat in storage against
 * zero register rows, so the platform held bytes it had no record of. This is
 * the write path those migrations were built for.
 *
 * `file_url` holds the storage PATH, not a URL — same reasoning as
 * recordBatchPhoto: a signed URL expires, so persisting one stores a link that
 * works today and breaks silently later.
 *
 * Called only AFTER the bytes are up, so the register can never advertise a
 * document that does not exist. The reverse order leaves a row pointing at
 * nothing.
 *
 * sha256_hex and sha256_recorded_at are written together because the table's
 * `sha256_pairing_check` requires both or neither. The schema permits both NULL
 * for rows that predate hashing; THIS PATH NEVER PRODUCES ONE — an unhashed new
 * upload would be a register entry that cannot support the only integrity claim
 * the register exists to make.
 */
export async function recordCoaDocument(input: {
  farmId?: string
  batchId: string
  fileName: string
  storagePath: string
  sha256Hex: string
}): Promise<{ id: string }> {
  if (!supabase) throw new Error('Supabase not configured')
  if (!/^[0-9a-f]{64}$/.test(input.sha256Hex)) {
    // Fail here rather than at the CHECK constraint: a 23514 from PostgREST
    // reaches the farmer as an opaque failure, and an uppercase or truncated
    // digest is a programming error worth naming precisely.
    throw new Error('COA digest is not a 64-character lower-case hex SHA-256.')
  }
  const id = crypto.randomUUID()
  await sbInsert('farmer_documents', {
    id,
    farm_id: input.farmId && isValidUUID(input.farmId) ? input.farmId : null,
    inventory_batch_id: input.batchId,
    document_type: 'coa',
    file_name: input.fileName,
    file_url: input.storagePath,
    sha256_hex: input.sha256Hex,
    sha256_recorded_at: new Date().toISOString(),
    // review_status is left to its 'pending' default. A document is not
    // reviewed by being uploaded, and defaulting it to anything else would
    // manufacture a review that no person performed.
  })
  return { id }
}

/**
 * Load the evidence register for administrator review.
 *
 * Reads under the caller's own policies — "farmer_documents: admin all" is what
 * returns every row here, and a farmer running the same query sees only their
 * own. This function adds no privilege.
 *
 * THROWS on failure rather than degrading to an empty array. An empty register
 * and an unreadable one look identical on screen, and "no documents are waiting
 * for review" is a very different statement from "we could not find out". The
 * caller renders a failed state; loadBatchPhotosFromDB degrades quietly because
 * a missing thumbnail is cosmetic, and a missing review queue is not.
 */
export async function loadFarmerDocuments(): Promise<FarmerDocument[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase
    .from('farmer_documents')
    .select('id, farm_id, inventory_batch_id, document_type, file_name, file_url, sha256_hex, sha256_recorded_at, review_status, uploaded_at, reviewed_at, reviewed_by')
    .order('uploaded_at', { ascending: false })

  if (error) {
    console.error('Supabase error [farmer_documents select]:', error)
    throw new Error(error.message)
  }

  return (data ?? []).map((row): FarmerDocument => ({
    id: row.id as string,
    farmId: (row.farm_id as string) ?? undefined,
    batchId: (row.inventory_batch_id as string) ?? undefined,
    documentType: ((row.document_type as FarmerDocumentType) ?? 'other'),
    fileName: (row.file_name as string) ?? undefined,
    storagePath: (row.file_url as string) ?? undefined,
    sha256Hex: (row.sha256_hex as string) ?? undefined,
    sha256RecordedAt: (row.sha256_recorded_at as string) ?? undefined,
    reviewStatus: ((row.review_status as DocumentReviewStatus) ?? 'pending'),
    uploadedAt: (row.uploaded_at as string) ?? '',
    reviewedAt: (row.reviewed_at as string) ?? undefined,
    reviewedBy: (row.reviewed_by as string) ?? undefined,
  }))
}

/**
 * Record an administrator's decision on one document.
 *
 * Writes ONLY review_status. `reviewed_by` and `reviewed_at` are deliberately
 * not sent: migration 64's BEFORE UPDATE trigger takes the reviewer from
 * auth.uid() and overwrites anything supplied, so an administrator cannot
 * attribute their decision to a colleague. Sending them here would be dead
 * weight that reads as though the client chooses the reviewer.
 *
 * If migration 64 is absent the update still succeeds and simply records no
 * reviewer — so this function is safe against either schema, and the constraint
 * `review_decision_requires_reviewer` is what makes the attributed outcome the
 * only possible one once the migration is applied.
 */
export async function setDocumentReviewStatus(
  documentId: string,
  status: DocumentReviewStatus,
): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (!isValidUUID(documentId)) throw new Error('A document id must be a UUID.')
  await sbUpdate('farmer_documents', { review_status: status }, 'id', documentId)
}

// Generate a 1-hour signed URL for a private COA file.
// Returns null if Supabase is not configured or the path is empty.
export async function getCoaSignedUrl(storagePath: string): Promise<string | null> {
  if (!supabase || !storagePath) return null
  const { data, error } = await supabase.storage
    .from('farmer-documents')
    .createSignedUrl(storagePath, 3600)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

// ---------------------------------------------------------------------------
// Batch photos — durable storage path (migration 37 bucket + farmer_photos)
//
// Before this existed, a farmer could attach photos to a batch and every one was
// SILENTLY DISCARDED at save: they are held as base64 `data:` URLs and
// createInventoryBatch filters those out, with no upload path and no warning.
// The farmer believed the photos were on file; nothing was.
//
// The durable path mirrors the COA one exactly: bytes go to a PRIVATE bucket,
// and only the storage PATH is recorded in the database. The row goes in
// public.farmer_photos, which has carried the right RLS since FARMER_MVP_MIGRATION
// (admin all / farmer select own / farmer insert own gated on the batch being
// created_by auth.uid()) — the table was ready, the code was missing.
// ---------------------------------------------------------------------------

/** The bucket asserted private by migration 37. */
const PHOTO_BUCKET = 'farmer-photos'

/**
 * Image types accepted for upload.
 *
 * An explicit allow-list, not a `startsWith('image/')` test. The input carries
 * `accept="image/*"`, which is a browser hint a caller can bypass, and `image/*`
 * also admits SVG — which can carry script and would then be served from our own
 * origin. Fail closed on anything not named here.
 *
 * HEIC/HEIF are included deliberately: they are the iPhone default, so omitting
 * them would reject the most common phone photo on the platform most farmers use.
 */
export const ACCEPTED_PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

/** Matches the file_size_limit migration 37 sets on the bucket (10 MiB). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/**
 * Validate a candidate photo before any upload is attempted.
 *
 * Returns null when acceptable, or a reason code the UI maps to a translated
 * message. Rejecting here rather than at the storage API means the farmer is
 * told why, in their own language, instead of seeing a bucket error.
 */
export function validatePhotoFile(file: File): 'type' | 'size' | 'empty' | null {
  if (file.size === 0) return 'empty'
  if (!ACCEPTED_PHOTO_MIME_TYPES.includes(file.type as typeof ACCEPTED_PHOTO_MIME_TYPES[number])) {
    return 'type'
  }
  if (file.size > MAX_PHOTO_BYTES) return 'size'
  return null
}

/**
 * Upload one photo to the private farmer-photos bucket.
 *
 * The path is uid-prefixed because every storage policy on these buckets gates
 * on `auth.uid()::text = (string_to_array(name,'/'))[1]`. A path that does not
 * start with the uploader's own id is rejected by the database, not by us — so
 * the prefix is load-bearing, not cosmetic.
 *
 * `upsert: false` so a repeated submit cannot overwrite an existing object; the
 * timestamp already makes collisions vanishingly unlikely, and silently
 * replacing evidence is worse than failing.
 */
export async function uploadBatchPhoto(
  file: File,
  userId: string,
  farmId: string,
  batchId: string,
): Promise<{ storagePath: string }> {
  if (!supabase) throw new Error('Supabase not configured')
  const reason = validatePhotoFile(file)
  if (reason) throw new Error(`Photo rejected (${reason}): ${file.name}`)
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  const storagePath = `${userId}/${farmId}/${batchId}/${Date.now()}-${safeName}`
  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false })
  if (error) throw new Error(`Photo upload failed: ${error.message}`)
  return { storagePath }
}

/**
 * Record an uploaded photo in public.farmer_photos.
 *
 * `file_url` holds the storage PATH, not a URL. The column predates Storage
 * being wired up and its own migration comment says it "should point to Supabase
 * Storage once configured" — a path is that reference. A signed URL must never
 * be persisted here: signed URLs expire, so a stored one is a link that works
 * today and breaks silently later.
 *
 * Called only AFTER the bytes are up, so the table can never advertise a photo
 * that does not exist. The reverse order would leave a row pointing at nothing.
 */
export async function recordBatchPhoto(input: {
  farmId?: string
  batchId: string
  storagePath: string
  photoType?: BatchPhotoType
  caption?: string
}): Promise<StoredPhoto> {
  if (!supabase) throw new Error('Supabase not configured')
  const row = {
    id: crypto.randomUUID(),
    farm_id: input.farmId && isValidUUID(input.farmId) ? input.farmId : null,
    inventory_batch_id: input.batchId,
    photo_type: input.photoType ?? 'product',
    file_url: input.storagePath,
    caption: input.caption ?? null,
  }
  await sbInsert('farmer_photos', row)
  return {
    id: row.id,
    batchId: input.batchId,
    farmId: input.farmId,
    photoType: row.photo_type as BatchPhotoType,
    storagePath: input.storagePath,
    caption: input.caption,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Signed URL for one stored photo. One hour, matching the COA path.
 * Returns null rather than throwing so a single unreadable photo cannot break a
 * whole review page.
 */
export async function getPhotoSignedUrl(storagePath: string): Promise<string | null> {
  if (!supabase || !storagePath) return null
  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(storagePath, 3600)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * Load stored photos for a set of batches, keyed by batch id.
 *
 * Returns an empty map rather than throwing: photos are supporting evidence, and
 * a failure to read them must not blank out the inventory they belong to. The
 * failure IS logged so it is not invisible.
 */
export async function loadBatchPhotosFromDB(
  batchIds: string[],
): Promise<Map<string, StoredPhoto[]>> {
  const byBatch = new Map<string, StoredPhoto[]>()
  const ids = batchIds.filter(isValidUUID)
  if (!supabase || ids.length === 0) return byBatch

  const { data, error } = await supabase
    .from('farmer_photos')
    .select('id, farm_id, inventory_batch_id, photo_type, file_url, caption, created_at')
    .in('inventory_batch_id', ids)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Supabase error [farmer_photos select]:', error)
    return byBatch
  }

  for (const row of data ?? []) {
    const batchId = row.inventory_batch_id as string
    // A row whose file_url is empty records no retrievable photo. Skip it rather
    // than render a broken thumbnail that implies evidence exists.
    const storagePath = (row.file_url as string) ?? ''
    if (!batchId || !storagePath) continue
    const photo: StoredPhoto = {
      id: row.id as string,
      batchId,
      farmId: (row.farm_id as string) ?? undefined,
      photoType: (row.photo_type as BatchPhotoType) ?? 'other',
      storagePath,
      caption: (row.caption as string) ?? undefined,
      createdAt: (row.created_at as string) ?? '',
    }
    const existing = byBatch.get(batchId)
    if (existing) existing.push(photo)
    else byBatch.set(batchId, [photo])
  }

  return byBatch
}

// ---------------------------------------------------------------------------
// Row mappers — convert raw Supabase rows to frontend shapes.
// ---------------------------------------------------------------------------

function toInventoryStatus(raw: unknown): InventoryStatus {
  const valid: InventoryStatus[] = ['Pending Review', 'Approved', 'Missing Document', 'Rejected']
  return valid.includes(raw as InventoryStatus) ? (raw as InventoryStatus) : 'Pending Review'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function batchRowToInventoryItem(row: Record<string, any>, farmName?: string): InventoryItem {
  const farm = row.farms as { farm_name?: string; trading_name?: string } | null
  const name = farmName ?? farm?.trading_name ?? farm?.farm_name ?? ''
  return {
    id: row.id as string,
    farmerName: name,
    farmName: name,
    farmId: row.farm_id as string ?? undefined,
    location: row.location as string ?? '',
    productName: row.product_name as string ?? '',
    quantityKg: (row.quantity_kg as number) ?? 0,
    harvestDate: row.harvest_date as string ?? '',
    cureDate: row.cure_date as string ?? '',
    batchNumber: row.batch_number as string ?? '',
    thcPct: (row.thc_percent as number) ?? 0,
    cbdPct: (row.cbd_percent as number) ?? 0,
    moisturePct: (row.moisture_percent as number) ?? 0,
    waterActivity: String(row.water_activity ?? ''),
    qualityGrade: row.quality_grade as string ?? '',
    pricePerKg: (row.price_per_kg as number) ?? 0,
    // Carried so an edit cannot silently redenominate the batch. Without this
    // the item loads with no currency, the write path falls back to THB, and a
    // 100 USD batch is saved as 100 THB with the number untouched. Unknown
    // values are dropped rather than trusted — the column's CHECK allows only
    // THB/USD/EUR, so anything else is data this build does not understand.
    priceCurrency: (BATCH_PRICE_CURRENCIES as readonly string[]).includes(row.price_currency as string)
      ? (row.price_currency as BatchPriceCurrency)
      : undefined,
    certFileName: row.coa_file_name as string ?? '',
    photoUrl: row.photo_url as string ?? '',
    storageConditions: row.storage_conditions as string ?? '',
    notes: row.notes as string ?? '',
    status: toInventoryStatus(row.status),
    submittedAt: row.created_at as string ?? new Date().toISOString(),
    stockStatus: row.stock_status as StockStatus ?? undefined,
    productType: row.product_type as ProductType ?? undefined,
    unit: (row.unit as 'g' | 'kg') ?? 'kg',
    minimumOrderKg: row.minimum_order_kg as number ?? undefined,
    totalTerpenesPct: row.total_terpenes_pct as number ?? undefined,
    expiryDate: row.expiry_date as string ?? undefined,
    clientVisible: (row.client_visible as boolean) ?? false,
    coaAvailable: (row.coa_available as boolean) ?? false,
    labName: row.lab_name as string ?? undefined,
    reportNumber: row.report_number as string ?? undefined,
    sampleName: row.sample_name as string ?? undefined,
    testDate: row.test_date as string ?? undefined,
    heavyMetalsStatus: row.heavy_metals_status as TestStatus ?? undefined,
    pesticidesStatus: row.pesticides_status as TestStatus ?? undefined,
    microbialStatus: row.microbial_status as TestStatus ?? undefined,
    mycotoxinsStatus: row.mycotoxins_status as TestStatus ?? undefined,
    photoUrls: (row.photo_urls as string[]) ?? undefined,
    farmerNotes: row.farmer_notes as string ?? undefined,
    // Present only for a ddp_admin: RLS on batch_internal_notes returns no row
    // to anyone else, so the join comes back empty and this stays undefined.
    ownerNotes: (row.batch_internal_notes as { note?: string }[] | null)?.[0]?.note ?? undefined,
    coaStoragePath: row.coa_storage_path as string ?? undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function farmRowToProfile(row: Record<string, any>): FarmProfile {
  // farm_profiles is returned as an array by the PostgREST join; take the first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp = (Array.isArray(row.farm_profiles) ? row.farm_profiles[0] : row.farm_profiles) as Record<string, any> ?? {}
  const bi  = (fp.business_info          as Record<string, string>) ?? {}
  const own = (fp.ownership              as Record<string, string>) ?? {}
  const lic = (fp.licenses               as Record<string, string>) ?? {}
  const fac = (fp.facility               as Record<string, string>) ?? {}
  const cul = (fp.cultivation            as Record<string, string>) ?? {}
  const str = (fp.strains                as Record<string, string>) ?? {}
  const lab = (fp.lab_testing            as Record<string, string>) ?? {}
  const exp = (fp.export_readiness_data  as Record<string, string>) ?? {}
  const mon = (fp.monthly_reporting      as Record<string, string>) ?? {}

  return {
    id: row.id as string,
    status: (row.status as FarmStatus) ?? 'Submitted to DDP',
    submittedAt: (row.created_at as string) ?? new Date().toISOString(),
    completionPct: (row.completion_percentage as number) ?? 0,
    legalBusinessName: bi.legalBusinessName ?? (row.legal_business_name as string) ?? '',
    tradingName: bi.tradingName ?? (row.trading_name as string) ?? (row.farm_name as string) ?? '',
    registrationNumber: bi.registrationNumber ?? '',
    taxNumber: bi.taxNumber ?? '',
    dateEstablished: bi.dateEstablished ?? '',
    province: bi.province ?? (row.province as string) ?? '',
    district: bi.district ?? (row.district as string) ?? '',
    gpsCoordinates: bi.gpsCoordinates ?? (row.gps_coordinates as string) ?? '',
    registeredAddress: bi.registeredAddress ?? '',
    operationalAddress: bi.operationalAddress ?? '',
    website: bi.website ?? '',
    facebook: bi.facebook ?? '',
    lineId: bi.lineId ?? '',
    whatsapp: bi.whatsapp ?? '',
    email: bi.email ?? (row.email as string) ?? '',
    primaryContact: bi.primaryContact ?? (row.primary_contact as string) ?? '',
    position: bi.position ?? '',
    mobileNumber: bi.mobileNumber ?? (row.mobile_number as string) ?? '',
    secondaryContact: bi.secondaryContact ?? '',
    emergencyContact: bi.emergencyContact ?? '',
    ownerName: own.ownerName ?? '',
    nationality: own.nationality ?? '',
    ownershipPct: own.ownershipPct ?? '',
    additionalShareholders: own.additionalShareholders ?? '',
    ownershipBreakdown: own.ownershipBreakdown ?? '',
    ultimateBeneficialOwners: own.ultimateBeneficialOwners ?? '',
    parentCompany: own.parentCompany ?? '',
    subsidiaries: own.subsidiaries ?? '',
    foreignInvestors: own.foreignInvestors ?? '',
    strategicPartners: own.strategicPartners ?? '',
    exportPartners: own.exportPartners ?? '',
    cultivationLicence: lic.cultivationLicence ?? '',
    processingLicence: lic.processingLicence ?? '',
    manufacturingLicence: lic.manufacturingLicence ?? '',
    researchLicence: lic.researchLicence ?? '',
    medicalCannabisLicence: lic.medicalCannabisLicence ?? '',
    exportLicence: lic.exportLicence ?? '',
    importLicence: lic.importLicence ?? '',
    gmpCert: lic.gmpCert ?? '',
    gapCert: lic.gapCert ?? '',
    gacpCert: lic.gacpCert ?? '',
    picsCert: lic.picsCert ?? '',
    organicCert: lic.organicCert ?? '',
    isoCerts: lic.isoCerts ?? '',
    otherCerts: lic.otherCerts ?? '',
    documentExpiry: lic.documentExpiry ?? '',
    farmType: fac.farmType ?? '',
    totalLandArea: fac.totalLandArea ?? '',
    cultivationArea: fac.cultivationArea ?? '',
    floweringArea: fac.floweringArea ?? '',
    nurseryArea: fac.nurseryArea ?? '',
    motherPlantArea: fac.motherPlantArea ?? '',
    processingArea: fac.processingArea ?? '',
    dryingArea: fac.dryingArea ?? '',
    storageArea: fac.storageArea ?? '',
    securityArea: fac.securityArea ?? '',
    expansionCapacity: fac.expansionCapacity ?? '',
    facilityPhotoUrl: fac.facilityPhotoUrl ?? '',
    activeRooms: cul.activeRooms ?? '',
    harvestsPerYear: cul.harvestsPerYear ?? '',
    avgYieldPerHarvest: cul.avgYieldPerHarvest ?? '',
    annualCapacity: cul.annualCapacity ?? '',
    currentInventory: cul.currentInventory ?? '',
    projectedInventory: cul.projectedInventory ?? '',
    productionUtilisation: cul.productionUtilisation ?? '',
    maxProductionCapacity: cul.maxProductionCapacity ?? '',
    cultivationMethod: cul.cultivationMethod ?? '',
    fertiliserProgram: cul.fertiliserProgram ?? '',
    nutrientBrands: cul.nutrientBrands ?? '',
    pestManagement: cul.pestManagement ?? '',
    ipmProcedures: cul.ipmProcedures ?? '',
    waterSource: cul.waterSource ?? '',
    waterTestingFrequency: cul.waterTestingFrequency ?? '',
    waterAnalysisFile: cul.waterAnalysisFile ?? '',
    mainStrains: str.mainStrains ?? '',
    breeder: str.breeder ?? '',
    geneticLineage: str.geneticLineage ?? '',
    typicalThc: str.typicalThc ?? '',
    typicalCbd: str.typicalCbd ?? '',
    dominantTerpenes: str.dominantTerpenes ?? '',
    harvestCycle: str.harvestCycle ?? '',
    yieldPerSqm: str.yieldPerSqm ?? '',
    qtyAvailableNow: str.qtyAvailableNow ?? '',
    qtyAvailable30: str.qtyAvailable30 ?? '',
    qtyAvailable60: str.qtyAvailable60 ?? '',
    qtyAvailable90: str.qtyAvailable90 ?? '',
    qtyAvailable180: str.qtyAvailable180 ?? '',
    productPhotoUrl: str.productPhotoUrl ?? '',
    coaFiles: lab.coaFiles ?? '',
    heavyMetalsTested: lab.heavyMetalsTested ?? '',
    pesticidesTested: lab.pesticidesTested ?? '',
    mycotoxinsTested: lab.mycotoxinsTested ?? '',
    microbiologyTested: lab.microbiologyTested ?? '',
    waterActivityTested: lab.waterActivityTested ?? '',
    batchTrackingSystem: lab.batchTrackingSystem ?? '',
    seedToSaleSystem: lab.seedToSaleSystem ?? '',
    sopsAvailable: lab.sopsAvailable ?? '',
    recallProcedure: lab.recallProcedure ?? '',
    wasteDisposal: lab.wasteDisposal ?? '',
    employeeTraining: lab.employeeTraining ?? '',
    securityProtocols: lab.securityProtocols ?? '',
    visitorProcedures: lab.visitorProcedures ?? '',
    incidentReporting: lab.incidentReporting ?? '',
    capaProgram: lab.capaProgram ?? '',
    internalAudits: lab.internalAudits ?? '',
    externalAudits: lab.externalAudits ?? '',
    suppliedEU: exp.suppliedEU ?? '',
    suppliedPharma: exp.suppliedPharma ?? '',
    suppliedGMPProcessors: exp.suppliedGMPProcessors ?? '',
    existingSopLibrary: exp.existingSopLibrary ?? '',
    existingQA: exp.existingQA ?? '',
    existingQC: exp.existingQC ?? '',
    qualifiedPerson: exp.qualifiedPerson ?? '',
    stabilityProgram: exp.stabilityProgram ?? '',
    changeControl: exp.changeControl ?? '',
    deviationProcedures: exp.deviationProcedures ?? '',
    riskManagement: exp.riskManagement ?? '',
    documentationControl: exp.documentationControl ?? '',
    countriesExported: exp.countriesExported ?? '',
    freightProviders: exp.freightProviders ?? '',
    customsBrokers: exp.customsBrokers ?? '',
    incotermsFamiliarity: exp.incotermsFamiliarity ?? '',
    packagingStandards: exp.packagingStandards ?? '',
    labellingStandards: exp.labellingStandards ?? '',
    shippingCapacity: exp.shippingCapacity ?? '',
    interestedExclusive: exp.interestedExclusive ?? '',
    interestedNonExclusive: exp.interestedNonExclusive ?? '',
    interestedEUGMP: exp.interestedEUGMP ?? '',
    interestedLongTerm: exp.interestedLongTerm ?? '',
    interestedJV: exp.interestedJV ?? '',
    monthlyReportingAgreement: mon.monthlyReportingAgreement ?? '',
    scoreCompliance: 0,
    scoreDocumentation: 0,
    scoreFacilityQuality: 0,
    scoreProductQuality: 0,
    scoreExportReadiness: 0,
    scoreReliability: 0,
    scoreCommunication: 0,
    scoreScalability: 0,
    scoreGMPReadiness: 0,
  }
}

// ---------------------------------------------------------------------------
// Supabase read functions — used in Supabase-configured mode only.
// Demo mode (no env vars) continues to use localStorage via lsLoad* above.
// ---------------------------------------------------------------------------

// Fetch farm profiles for a specific set of farm IDs. Used by farmer pages
// so the Add Stock form has a real selectedFarm and writes farm_id correctly.
export async function loadFarmerFarmsFromDB(farmIds: Set<string>): Promise<FarmProfile[]> {
  if (!supabase) return []
  const idList = [...farmIds].filter(isValidUUID)
  if (idList.length === 0) return []
  const { data, error } = await supabase
    .from('farms')
    .select(`
      *,
      farm_profiles (
        business_info,
        ownership,
        licenses,
        facility,
        cultivation,
        strains,
        lab_testing,
        export_readiness_data,
        monthly_reporting
      )
    `)
    .in('id', idList)
    .order('created_at', { ascending: false })
  if (error) {
    console.warn('loadFarmerFarmsFromDB:', error.message)
    return []
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => farmRowToProfile(row))
}

// Fetch all farms + their profile JSON blobs. Used by admin pages.
export async function loadFarmsFromDB(): Promise<FarmProfile[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('farms')
    .select(`
      *,
      farm_profiles (
        business_info,
        ownership,
        licenses,
        facility,
        cultivation,
        strains,
        lab_testing,
        export_readiness_data,
        monthly_reporting
      )
    `)
    .order('created_at', { ascending: false })
  if (error) {
    // Throw (not silent []) so a query failure is distinguishable from a
    // legitimately empty farm table — the caller marks the source failed.
    throw new Error(`loadFarmsFromDB: ${error.message}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => farmRowToProfile(row))
}

// Fetch all inventory batches. Used by admin pages.
/**
 * Attach durable photo records to freshly loaded batches.
 *
 * Applied inside BOTH load paths rather than at the call site, so admin and
 * farmer views cannot drift — a photo visible to one and not the other would look
 * like missing evidence rather than a wiring bug.
 *
 * Never throws: loadBatchPhotosFromDB already degrades to an empty map, so a
 * photo-query failure leaves the inventory intact and simply photo-less.
 */
async function withStoredPhotos(items: InventoryItem[]): Promise<InventoryItem[]> {
  if (items.length === 0) return items
  const byBatch = await loadBatchPhotosFromDB(items.map(i => i.id))
  if (byBatch.size === 0) return items
  return items.map(i => {
    const photos = byBatch.get(i.id)
    return photos && photos.length > 0 ? { ...i, storedPhotos: photos } : i
  })
}

export async function loadInventoryFromDB(): Promise<InventoryItem[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('inventory_batches')
    .select('*, farms(farm_name, trading_name), batch_internal_notes(note)')
    .order('created_at', { ascending: false })
  if (error) {
    // Throw (not silent []) so a query failure is distinguishable from a
    // legitimately empty inventory table — the caller marks the source failed.
    throw new Error(`loadInventoryFromDB: ${error.message}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withStoredPhotos((data ?? []).map((row: any) => batchRowToInventoryItem(row)))
}

// Fetch the actual inventory rows for a specific farmer's scope.
// Called after getFarmerScope() resolves so the farmer sees their real batches.
export async function loadFarmerInventoryFromDB(
  itemIds: Set<string>,
  farmIds: Set<string>,
): Promise<InventoryItem[]> {
  if (!supabase) return []
  const idList   = [...itemIds].filter(isValidUUID)
  const farmList = [...farmIds].filter(isValidUUID)
  if (idList.length === 0 && farmList.length === 0) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any)
    .from('inventory_batches')
    .select('*, farms(farm_name, trading_name), batch_internal_notes(note)')

  if (idList.length > 0 && farmList.length > 0) {
    query = query.or(`id.in.(${idList.join(',')}),farm_id.in.(${farmList.join(',')})`)
  } else if (idList.length > 0) {
    query = query.in('id', idList)
  } else {
    query = query.in('farm_id', farmList)
  }

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) {
    console.warn('loadFarmerInventoryFromDB:', error.message)
    return []
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withStoredPhotos((data ?? []).map((row: any) => batchRowToInventoryItem(row)))
}

// ---------------------------------------------------------------------------
// Farmer data scoping — returns the set of farm IDs and inventory item IDs
// owned by a specific user in Supabase mode.
//
// farmIds  = farm_memberships.farm_id WHERE user_id = userId
//          ∪ farms.id WHERE created_by = userId
// itemIds  = inventory_batches.id WHERE created_by = userId
//          ∪ inventory_batches.id WHERE farm_id ∈ farmIds
//
// Returns empty sets when Supabase is not configured or userId is not a UUID.
// ---------------------------------------------------------------------------
export interface FarmerScope {
  farmIds: Set<string>
  itemIds: Set<string>
}

export async function getFarmerScope(userId: string): Promise<FarmerScope> {
  const empty: FarmerScope = { farmIds: new Set(), itemIds: new Set() }
  if (!supabase || !isValidUUID(userId)) return empty

  const [membershipsRes, createdFarmsRes] = await Promise.all([
    supabase.from('farm_memberships').select('farm_id').eq('user_id', userId),
    supabase.from('farms').select('id').eq('created_by', userId),
  ])
  if (membershipsRes.error) console.warn('getFarmerScope memberships:', membershipsRes.error.message)
  if (createdFarmsRes.error) console.warn('getFarmerScope farms.created_by:', createdFarmsRes.error.message)

  const farmIds = new Set<string>([
    ...(membershipsRes.data ?? []).map(m => m.farm_id as string),
    ...(createdFarmsRes.data ?? []).map(f => f.id as string),
  ])

  // Fetch inventory owned directly (created_by) or linked to an owned farm
  const itemsRes = farmIds.size > 0
    ? await supabase
        .from('inventory_batches')
        .select('id')
        .or(`created_by.eq.${userId},farm_id.in.(${[...farmIds].join(',')})`)
    : await supabase
        .from('inventory_batches')
        .select('id')
        .eq('created_by', userId)

  if (itemsRes.error) console.warn('getFarmerScope inventory_batches:', itemsRes.error.message)
  const itemIds = new Set<string>((itemsRes.data ?? []).map(i => i.id as string))

  return { farmIds, itemIds }
}

// ---------------------------------------------------------------------------
// Persist helpers — write-through to browser storage on every React state change
// (App.tsx:117-118), but ONLY IN DEMO MODE.
//
// These were previously unconditional. In Supabase mode `inventory` and `farms`
// hold data fetched from the production database, so every state change mirrored
// the ENTIRE production dataset into localStorage — unencrypted, on the operator's
// machine, and (before this change) still there after sign-out. The matching read
// path was already guarded (data.ts:624, :637 return [] when Supabase is
// configured), so nothing reads these copies in Supabase mode; they were pure leak.
//
// Demo mode is unchanged: localStorage is the store, and it still persists.
// ---------------------------------------------------------------------------

export function persistInventory(items: InventoryItem[]): void {
  if (!shouldPersistToBrowser()) return
  lsSaveInventory(items)
}

export function persistFarms(farms: FarmProfile[]): void {
  if (!shouldPersistToBrowser()) return
  lsSaveFarms(farms)
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export async function resetDemoData(): Promise<void> {
  lsResetDemo()
}

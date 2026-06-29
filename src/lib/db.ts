import { supabase, isSupabaseConfigured } from './supabase'
import {
  loadInventory as lsLoadInventory,
  saveInventory as lsSaveInventory,
  loadFarms as lsLoadFarms,
  saveFarms as lsSaveFarms,
  resetDemo as lsResetDemo,
  SEED_BENCHMARKS,
} from '../data'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark } from '../types'

export { isSupabaseConfigured }

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

// ---------------------------------------------------------------------------
// Farm Profiles
// ---------------------------------------------------------------------------

export function getFarmProfiles(): FarmProfile[] {
  return lsLoadFarms()
}

export async function createFarmProfile(farm: FarmProfile, userId?: string): Promise<void> {
  // localStorage is always written first (sync, never fails)
  const existing = lsLoadFarms()
  lsSaveFarms([farm, ...existing.filter(f => f.id !== farm.id)])

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
    compliance_status: null,
    export_readiness: null,
    risk_level: null,
    partner_tier: farm.partnerTier,
    created_by: userId ?? null,
    updated_at: new Date().toISOString(),
  })

  console.log('Created farm id:', farm.id)
  console.log('Creating farm_profile for farm id:', farm.id)

  // 2. farm_profiles row (full profile data split into JSONB sections)
  await sbInsert('farm_profiles', {
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
  })

  // 3. farm_memberships — link the creating user as farm owner
  if (userId && isValidUUID(userId)) {
    console.log('Creating farm_membership for farm id:', farm.id, 'user id:', userId)
    await sbInsert('farm_memberships', {
      farm_id: farm.id,
      user_id: userId,
      role: 'owner',
    })
  }
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
  // localStorage is always written first
  const existing = lsLoadInventory()
  lsSaveInventory([item, ...existing.filter(i => i.id !== item.id)])

  if (!supabase) return

  if (!isValidUUID(item.id)) {
    console.warn(`createInventoryBatch: skipping Supabase write — "${item.id}" is not a valid UUID`)
    return
  }

  console.log('Creating inventory batch in Supabase', { id: item.id, productName: item.productName })

  // Filter out data URLs — they can be 500 KB+ and don't belong in the DB.
  // In production, replace with Supabase Storage URLs.
  const storablePhotoUrls = (item.photoUrls ?? []).filter(u => !u.startsWith('data:'))

  await sbUpsert('inventory_batches', {
    id: item.id,
    farm_id: item.farmId && isValidUUID(item.farmId) ? item.farmId : null,
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
    farmer_notes: item.farmerNotes ?? null,
    owner_notes: item.ownerNotes ?? null,
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
// Patch an inventory batch — for admin actions (client_visible toggle,
// owner_notes) and farmer re-submissions (stock_status change).
// ---------------------------------------------------------------------------
export async function patchInventoryBatch(
  itemId: string,
  fields: Partial<{
    stock_status: string
    client_visible: boolean
    owner_notes: string
    status: InventoryStatus
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

export async function loadReviewRequestsFromDB(
  userId: string,
  _farmIds: Set<string>,
  itemIds: Set<string>,
): Promise<ReviewRequest[]> {
  if (!supabase || !isValidUUID(userId)) return []

  const batchIdList = [...itemIds].filter(isValidUUID)
  if (batchIdList.length === 0) return []

  const { data, error } = await supabase
    .from('farmer_review_requests')
    .select('*')
    .in('inventory_batch_id', batchIdList)
    .order('created_at', { ascending: false })

  if (error) {
    console.warn('loadReviewRequestsFromDB:', error.message)
    return []
  }

  return (data ?? []).map(row => ({
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
  }))
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

  if (error) {
    console.warn('loadMarketBenchmarksFromDB:', error.message)
    return SEED_BENCHMARKS
  }

  if (!data || data.length === 0) return SEED_BENCHMARKS

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

export function getApprovedInventory(): InventoryItem[] {
  return lsLoadInventory().filter(i => i.status === 'Approved')
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
// Persist helpers — write-through to localStorage on every React state change.
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
}

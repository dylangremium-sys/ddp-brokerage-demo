import { supabase, isSupabaseConfigured } from './supabase'
import { shouldPersistToBrowser } from './browserPersistence'
import { measurementFromRow } from './measurement'
import {
  loadInventory as lsLoadInventory,
  saveInventory as lsSaveInventory,
  loadFarms as lsLoadFarms,
  saveFarms as lsSaveFarms,
  resetDemo as lsResetDemo,
  SEED_BENCHMARKS,
} from '../data'
import type { FarmProfile, InventoryItem, FarmStatus, InventoryStatus, ReviewRequest, MarketBenchmark, StockStatus, ProductType, TestStatus } from '../types'

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
  console.log('Creating farm_profile for farm id:', farm.id)

  // 2. farm_profiles row (full profile data split into JSONB sections)
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

  // 3. farm_memberships — link the creating user as farm owner
  if (userId && isValidUUID(userId)) {
    console.log('Creating farm_membership for farm id:', farm.id, 'user id:', userId)
    await sbUpsertIgnore('farm_memberships', {
      farm_id: farm.id,
      user_id: userId,
      role: 'owner',
    }, 'farm_id,user_id')
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
    coa_storage_path: item.coaStoragePath ?? null,
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
    // NULL means no reading was reported. `?? 0` erased that, presenting an
    // absent measurement as a genuine 0.00% lab result. A stored 0 still maps
    // to 0 — see lib/measurement.
    thcPct: measurementFromRow(row.thc_percent),
    cbdPct: (row.cbd_percent as number) ?? 0,
    moisturePct: (row.moisture_percent as number) ?? 0,
    waterActivity: String(row.water_activity ?? ''),
    qualityGrade: row.quality_grade as string ?? '',
    pricePerKg: (row.price_per_kg as number) ?? 0,
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
    ownerNotes: row.owner_notes as string ?? undefined,
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
    console.warn('loadFarmsFromDB:', error.message)
    // Must reject, not resolve empty: a caller cannot tell "no farms on file"
    // from "the query failed" if both arrive as []. The Operations overview
    // reports counts from this data, so a failure presented as zero is a false
    // compliance claim. The query itself is unchanged.
    throw new Error(`Loading farms: ${error.message}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => farmRowToProfile(row))
}

// Fetch all inventory batches. Used by admin pages.
export async function loadInventoryFromDB(): Promise<InventoryItem[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('inventory_batches')
    .select('*, farms(farm_name, trading_name)')
    .order('created_at', { ascending: false })
  if (error) {
    console.warn('loadInventoryFromDB:', error.message)
    // Must reject, not resolve empty — see loadFarmsFromDB. "No batches on file"
    // and "Missing evidence: 0" are assertions of absence; a failed read may
    // never produce them. The query itself is unchanged.
    throw new Error(`Loading inventory batches: ${error.message}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => batchRowToInventoryItem(row))
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
    .select('*, farms(farm_name, trading_name)')

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
  return (data ?? []).map((row: any) => batchRowToInventoryItem(row))
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

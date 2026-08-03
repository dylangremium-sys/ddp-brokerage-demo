import type { InventoryItem, FarmProfile, ReviewRequest, MarketBenchmark, ComplianceVerificationTier, TestStatus } from './types'
import { REQUIREMENT_OVERRIDE_KEY, RISK_OVERRIDE_KEY, DECISION_KEY, getFarmInventory } from './lib/procurementControl'
import { safeSetItem, shouldPersistToBrowser } from './lib/browserPersistence'

export function testStatusLabel(s?: TestStatus): string {
  if (s === 'pass') return 'PASS'
  if (s === 'fail') return 'FAIL'
  if (s === 'not_tested') return 'NOT TESTED'
  return '—'
}

export function testStatusClass(s?: TestStatus): string {
  if (s === 'pass') return 'check-yes'
  if (s === 'fail') return 'check-no'
  return 'td-muted'
}

export const INV_KEY = 'ddp_inventory'
export const FARM_KEY = 'ddp_farms'
export const FARM_DRAFT_KEY = 'ddp_farm_draft'

// In Supabase mode, skip localStorage auto-seeding — data comes from the DB.
const sbConfigured = !!(
  (import.meta.env as Record<string, string | undefined>).VITE_SUPABASE_URL &&
  (import.meta.env as Record<string, string | undefined>).VITE_SUPABASE_ANON_KEY
)

export function calcCompletion(f: Partial<FarmProfile>): number {
  const fields = [
    f.legalBusinessName, f.tradingName, f.province, f.district, f.email,
    f.primaryContact, f.mobileNumber, f.ownerName, f.cultivationLicence,
    f.farmType, f.totalLandArea, f.cultivationArea, f.mainStrains,
    f.typicalThc, f.coaFiles, f.heavyMetalsTested, f.suppliedEU,
    f.monthlyReportingAgreement,
  ]
  const filled = fields.filter(v => v && v.toString().trim() !== '').length
  return Math.round((filled / fields.length) * 100)
}

export function farmTotalScore(f: FarmProfile): number {
  return (
    f.scoreCompliance +
    f.scoreDocumentation +
    f.scoreFacilityQuality +
    f.scoreProductQuality +
    f.scoreExportReadiness +
    f.scoreReliability +
    f.scoreCommunication +
    f.scoreScalability +
    f.scoreGMPReadiness
  )
}

/**
 * Whether this farm has actually BEEN scored.
 *
 * NOTHING COMPUTES THESE SCORES FOR A REAL FARM. The nine values are hardcoded
 * into the demo fixtures in this file (78, 80, 55, 92 …), and `db.ts` sets every
 * one of them to 0 when a profile is read back from Supabase — there are no score
 * columns in the database to read them from, and no function anywhere derives one
 * from profile data.
 *
 * So a real farm renders 0/900 with nine empty bars, which an admin reads as
 * "this farm scored zero on everything" when it means "we have not scored it".
 * On a farm with a complete profile that is not a cosmetic difference: it is the
 * screen asserting a commercial judgement nobody made.
 *
 * The risk flags and positive signals on the same panel ARE real — they are
 * derived from actual profile data, which is why a farm can show
 * "Strong production capacity" while every score reads 0. Those stay.
 *
 * This predicate exists so the UI can say "not yet scored" instead. When scoring
 * is genuinely built, this keeps working unchanged: a scored farm has at least
 * one non-zero component.
 */
export function isFarmScored(f: FarmProfile): boolean {
  return farmTotalScore(f) > 0
}

// Derives the 3-tier compliance status from audited, reliably-populated signals
// (status, licence/COA presence, completion %, and — critically — whether a real
// COA file has actually been received for one of the farm's batches) rather than
// the score fields above, which are not currently persisted for Supabase-backed
// farms. `f.coaFiles` and `f.gmpCert` etc. are free text typed by the farm, not a
// received document, so they can only ever support a "claimed" reading on their
// own; a farm can only clear DDP_DOCUMENTED or ADVANCED_DOCUMENTATION_REVIEW once at
// least one of its batches has a real uploaded COA (InventoryItem.coaStoragePath).
// Callers that can't supply `inventory` (no batch context available) will always
// see the conservative CULTIVATOR_CLAIMED tier rather than an overclaimed one.
export function deriveComplianceTier(f: FarmProfile, inventory: InventoryItem[] = []): ComplianceVerificationTier {
  const reviewed = (['Approved', 'Strategic Partner', 'Watchlist', 'Under Review'] as string[]).includes(f.status)
  const hasReceivedCoaFile = getFarmInventory(f, inventory).some(b => !!b.coaStoragePath)
  const hasLicenceClaim = !!f.cultivationLicence || !!f.exportLicence
  const hasCoreDocs = hasReceivedCoaFile && hasLicenceClaim
  const pharmaReady =
    (['Approved', 'Strategic Partner'] as string[]).includes(f.status) &&
    !!f.gmpCert && !!f.exportLicence &&
    (f.suppliedPharma === 'Yes' || f.suppliedGMPProcessors === 'Yes' || f.qualifiedPerson === 'Yes') &&
    f.heavyMetalsTested === 'Yes' && f.microbiologyTested === 'Yes' &&
    hasReceivedCoaFile

  if (pharmaReady) return 'ADVANCED_DOCUMENTATION_REVIEW'
  if (reviewed && hasCoreDocs && f.completionPct >= 60) return 'DDP_DOCUMENTED'
  return 'CULTIVATOR_CLAIMED'
}

export const COMPLIANCE_TIER_LABEL: Record<ComplianceVerificationTier, string> = {
  CULTIVATOR_CLAIMED: 'CULTIVATOR CLAIMED',
  DDP_DOCUMENTED: 'DDP DOCUMENTED',
  ADVANCED_DOCUMENTATION_REVIEW: 'ADVANCED DOCUMENTATION REVIEW',
}

export function complianceTierClass(tier: ComplianceVerificationTier): string {
  return `tier-${tier.toLowerCase().replace(/_/g, '-')}`
}

const NOW = new Date().toISOString()

export const SEED_FARMS: FarmProfile[] = [
  {
    id: 'farm-1',
    status: 'Submitted to DDP',
    submittedAt: NOW,
    completionPct: 82,
    legalBusinessName: 'Calli Krush Co., Ltd.',
    tradingName: 'Calli Krush',
    registrationNumber: 'TH-2021-BUR-4471',
    taxNumber: '0105564112233',
    dateEstablished: '2021-03-15',
    province: 'Buriram',
    district: 'Nang Rong',
    gpsCoordinates: '14.6340° N, 102.7910° E',
    registeredAddress: '112 Moo 5, Nang Rong, Buriram 31110',
    operationalAddress: '112 Moo 5, Nang Rong, Buriram 31110',
    website: 'www.callikrush.co.th',
    facebook: 'CalliKrushFarm',
    lineId: '@callikrush',
    whatsapp: '+66812345678',
    email: 'info@callikrush.co.th',
    primaryContact: 'Calli Krush',
    position: 'Managing Director',
    mobileNumber: '+66812345678',
    secondaryContact: 'Nattapong Srisuk',
    emergencyContact: '+66823456789',
    ownerName: 'Calli Krush',
    nationality: 'Thai',
    ownershipPct: '100',
    additionalShareholders: 'None',
    ownershipBreakdown: '100% Thai ownership',
    ultimateBeneficialOwners: 'Calli Krush',
    parentCompany: 'None',
    subsidiaries: 'None',
    foreignInvestors: 'None',
    strategicPartners: 'DDP Brokerage',
    exportPartners: 'In discussion with DDP',
    cultivationLicence: 'CL-BUR-2021-0047.pdf',
    processingLicence: 'PL-BUR-2021-0047.pdf',
    manufacturingLicence: '',
    researchLicence: '',
    medicalCannabisLicence: 'MCL-BUR-2022-0011.pdf',
    exportLicence: '',
    importLicence: '',
    gmpCert: '',
    gapCert: 'GAP-BUR-2023.pdf',
    gacpCert: 'GACP-BUR-2023.pdf',
    picsCert: '',
    organicCert: '',
    isoCerts: '',
    otherCerts: '',
    documentExpiry: '2026-03-15',
    farmType: 'Greenhouse',
    totalLandArea: '12 rai',
    cultivationArea: '8 rai',
    floweringArea: '5 rai',
    nurseryArea: '1 rai',
    motherPlantArea: '0.5 rai',
    processingArea: '300 sqm',
    dryingArea: '200 sqm',
    storageArea: '150 sqm',
    securityArea: 'Perimeter fenced with CCTV',
    expansionCapacity: '4 additional rai available',
    facilityPhotoUrl: '',
    activeRooms: '6',
    harvestsPerYear: '4',
    avgYieldPerHarvest: '600 kg',
    annualCapacity: '2400 kg',
    currentInventory: '2300 kg',
    projectedInventory: '2400 kg in Q1 2026',
    productionUtilisation: '85',
    maxProductionCapacity: '2800 kg/year',
    cultivationMethod: 'Controlled environment greenhouse',
    fertiliserProgram: 'Organic base with NPK supplementation',
    nutrientBrands: 'BioBizz, House & Garden',
    pestManagement: 'IPM with biological controls',
    ipmProcedures: 'Weekly scouting, beneficial insects, neem oil',
    waterSource: 'Borehole + municipal backup',
    waterTestingFrequency: 'Monthly',
    waterAnalysisFile: 'water_analysis_2025.pdf',
    mainStrains: 'Mango, Red Dragon, Purple Gelato',
    breeder: 'In-house selection + certified genetics',
    geneticLineage: 'Sativa-dominant hybrids',
    typicalThc: '22–27%',
    typicalCbd: '0.08–0.12%',
    dominantTerpenes: 'Myrcene, Limonene, Caryophyllene',
    harvestCycle: '10–12 weeks',
    yieldPerSqm: '450g',
    qtyAvailableNow: '2300 kg',
    qtyAvailable30: '600 kg',
    qtyAvailable60: '600 kg',
    qtyAvailable90: '600 kg',
    qtyAvailable180: '1800 kg',
    productPhotoUrl: '',
    coaFiles: 'Mango_COA_F4-122025.pdf, Red_Dragon_COA_F4-122025.pdf',
    heavyMetalsTested: 'Yes',
    pesticidesTested: 'Yes',
    mycotoxinsTested: 'Yes',
    microbiologyTested: 'Yes',
    waterActivityTested: 'Yes',
    batchTrackingSystem: 'Yes',
    seedToSaleSystem: 'Yes',
    sopsAvailable: 'Yes',
    recallProcedure: 'Yes',
    wasteDisposal: 'Yes',
    employeeTraining: 'Yes',
    securityProtocols: 'Yes',
    visitorProcedures: 'Yes',
    incidentReporting: 'Yes',
    capaProgram: 'Yes',
    internalAudits: 'Yes',
    externalAudits: 'No',
    suppliedEU: 'No',
    suppliedPharma: 'No',
    suppliedGMPProcessors: 'No',
    existingSopLibrary: 'Yes',
    existingQA: 'Yes',
    existingQC: 'Yes',
    qualifiedPerson: 'No',
    stabilityProgram: 'No',
    changeControl: 'Yes',
    deviationProcedures: 'Yes',
    riskManagement: 'Yes',
    documentationControl: 'Yes',
    countriesExported: 'None yet — targeting EU',
    freightProviders: 'TNT, DHL Express',
    customsBrokers: 'In discussion',
    incotermsFamiliarity: 'Basic — CIF, FOB',
    packagingStandards: 'Vacuum sealed, dark glass jars',
    labellingStandards: 'GHS compliant',
    shippingCapacity: 'Up to 500kg per shipment',
    interestedExclusive: 'Yes',
    interestedNonExclusive: 'Yes',
    interestedEUGMP: 'Yes',
    interestedLongTerm: 'Yes',
    interestedJV: 'No',
    monthlyReportingAgreement: 'Yes',
    scoreCompliance: 78,
    scoreDocumentation: 72,
    scoreFacilityQuality: 80,
    scoreProductQuality: 85,
    scoreExportReadiness: 62,
    scoreReliability: 75,
    scoreCommunication: 82,
    scoreScalability: 70,
    scoreGMPReadiness: 55,
  },
  {
    id: 'farm-2',
    status: 'More Information Required',
    submittedAt: NOW,
    completionPct: 54,
    legalBusinessName: 'Northern Green Farm Co., Ltd.',
    tradingName: 'Northern Green Farm',
    registrationNumber: 'TH-2022-CNX-1198',
    taxNumber: '0105565009911',
    dateEstablished: '2022-06-01',
    province: 'Chiang Mai',
    district: 'Mae Rim',
    gpsCoordinates: '18.9100° N, 98.9300° E',
    registeredAddress: '55 Moo 3, Mae Rim, Chiang Mai 50180',
    operationalAddress: '55 Moo 3, Mae Rim, Chiang Mai 50180',
    website: '',
    facebook: 'NorthernGreenFarm',
    lineId: '@ngreen',
    whatsapp: '',
    email: 'contact@northerngreen.co.th',
    primaryContact: 'Somchai Wiriya',
    position: 'Director',
    mobileNumber: '+66834567890',
    secondaryContact: '',
    emergencyContact: '',
    ownerName: 'Somchai Wiriya',
    nationality: 'Thai',
    ownershipPct: '70',
    additionalShareholders: 'Priya Patel (30%)',
    ownershipBreakdown: '70% Thai, 30% Indian national',
    ultimateBeneficialOwners: 'Somchai Wiriya',
    parentCompany: '',
    subsidiaries: '',
    foreignInvestors: 'Priya Patel — India',
    strategicPartners: '',
    exportPartners: '',
    cultivationLicence: 'CL-CNX-2022-0221.pdf',
    processingLicence: '',
    manufacturingLicence: '',
    researchLicence: '',
    medicalCannabisLicence: '',
    exportLicence: '',
    importLicence: '',
    gmpCert: '',
    gapCert: '',
    gacpCert: '',
    picsCert: '',
    organicCert: '',
    isoCerts: '',
    otherCerts: '',
    documentExpiry: '',
    farmType: 'Outdoor',
    totalLandArea: '6 rai',
    cultivationArea: '4 rai',
    floweringArea: '3 rai',
    nurseryArea: '0.5 rai',
    motherPlantArea: '',
    processingArea: '100 sqm',
    dryingArea: '80 sqm',
    storageArea: '50 sqm',
    securityArea: 'Fenced perimeter',
    expansionCapacity: '',
    facilityPhotoUrl: '',
    activeRooms: '2',
    harvestsPerYear: '2',
    avgYieldPerHarvest: '200 kg',
    annualCapacity: '400 kg',
    currentInventory: '180 kg',
    projectedInventory: '',
    productionUtilisation: '60',
    maxProductionCapacity: '500 kg/year',
    cultivationMethod: 'Outdoor organic',
    fertiliserProgram: 'Organic compost',
    nutrientBrands: '',
    pestManagement: 'Organic sprays',
    ipmProcedures: '',
    waterSource: 'Rainwater + irrigation canal',
    waterTestingFrequency: 'Quarterly',
    waterAnalysisFile: '',
    mainStrains: 'Haze Thai, Northern Lights',
    breeder: 'Local selection',
    geneticLineage: 'Sativa landrace',
    typicalThc: '14–18%',
    typicalCbd: '0.05–0.10%',
    dominantTerpenes: 'Myrcene, Pinene',
    harvestCycle: '14–16 weeks',
    yieldPerSqm: '200g',
    qtyAvailableNow: '180 kg',
    qtyAvailable30: '0',
    qtyAvailable60: '200 kg',
    qtyAvailable90: '0',
    qtyAvailable180: '200 kg',
    productPhotoUrl: '',
    coaFiles: '',
    heavyMetalsTested: 'No',
    pesticidesTested: 'No',
    mycotoxinsTested: 'No',
    microbiologyTested: 'No',
    waterActivityTested: 'No',
    batchTrackingSystem: 'No',
    seedToSaleSystem: 'No',
    sopsAvailable: 'No',
    recallProcedure: 'No',
    wasteDisposal: 'Yes',
    employeeTraining: 'No',
    securityProtocols: 'Yes',
    visitorProcedures: 'No',
    incidentReporting: 'No',
    capaProgram: 'No',
    internalAudits: 'No',
    externalAudits: 'No',
    suppliedEU: 'No',
    suppliedPharma: 'No',
    suppliedGMPProcessors: 'No',
    existingSopLibrary: 'No',
    existingQA: 'No',
    existingQC: 'No',
    qualifiedPerson: 'No',
    stabilityProgram: 'No',
    changeControl: 'No',
    deviationProcedures: 'No',
    riskManagement: 'No',
    documentationControl: 'No',
    countriesExported: 'None',
    freightProviders: '',
    customsBrokers: '',
    incotermsFamiliarity: 'None',
    packagingStandards: '',
    labellingStandards: '',
    shippingCapacity: '',
    interestedExclusive: 'No',
    interestedNonExclusive: 'Yes',
    interestedEUGMP: 'No',
    interestedLongTerm: 'Yes',
    interestedJV: 'No',
    monthlyReportingAgreement: 'No',
    scoreCompliance: 28,
    scoreDocumentation: 22,
    scoreFacilityQuality: 40,
    scoreProductQuality: 45,
    scoreExportReadiness: 15,
    scoreReliability: 30,
    scoreCommunication: 35,
    scoreScalability: 30,
    scoreGMPReadiness: 10,
  },
  {
    id: 'farm-3',
    status: 'Approved',
    submittedAt: NOW,
    completionPct: 91,
    legalBusinessName: 'Korat Medical Grow Co., Ltd.',
    tradingName: 'Korat Medical Grow',
    registrationNumber: 'TH-2020-NMA-0099',
    taxNumber: '0105563007788',
    dateEstablished: '2020-09-01',
    province: 'Nakhon Ratchasima',
    district: 'Pak Chong',
    gpsCoordinates: '14.7100° N, 101.4100° E',
    registeredAddress: '88 Moo 2, Pak Chong, Nakhon Ratchasima 30130',
    operationalAddress: '88 Moo 2, Pak Chong, Nakhon Ratchasima 30130',
    website: 'www.koratmedicalgrow.co.th',
    facebook: 'KoratMedicalGrow',
    lineId: '@koratmed',
    whatsapp: '+66845678901',
    email: 'quality@koratmedicalgrow.co.th',
    primaryContact: 'Dr. Araya Somchai',
    position: 'CEO / Qualified Person',
    mobileNumber: '+66845678901',
    secondaryContact: 'Chaiwat Pongpat',
    emergencyContact: '+66856789012',
    ownerName: 'Dr. Araya Somchai',
    nationality: 'Thai',
    ownershipPct: '85',
    additionalShareholders: 'Chaiwat Pongpat (15%)',
    ownershipBreakdown: '100% Thai ownership',
    ultimateBeneficialOwners: 'Dr. Araya Somchai',
    parentCompany: 'None',
    subsidiaries: 'None',
    foreignInvestors: 'None',
    strategicPartners: 'DDP Brokerage, Thai FDA liaison',
    exportPartners: 'Exploring EU channels via DDP',
    cultivationLicence: 'CL-NMA-2020-0099.pdf',
    processingLicence: 'PL-NMA-2020-0099.pdf',
    manufacturingLicence: 'ML-NMA-2021-0034.pdf',
    researchLicence: 'RL-NMA-2022-0017.pdf',
    medicalCannabisLicence: 'MCL-NMA-2021-0028.pdf',
    exportLicence: 'EL-NMA-2023-0005.pdf',
    importLicence: '',
    gmpCert: 'GMP-NMA-2023.pdf',
    gapCert: 'GAP-NMA-2022.pdf',
    gacpCert: 'GACP-NMA-2022.pdf',
    picsCert: 'PICS-NMA-2023.pdf',
    organicCert: 'ORG-NMA-2023.pdf',
    isoCerts: 'ISO9001-2023.pdf',
    otherCerts: 'DTTAM-NMA-2022.pdf',
    documentExpiry: '2026-09-01',
    farmType: 'Indoor',
    totalLandArea: '20 rai',
    cultivationArea: '15 rai',
    floweringArea: '10 rai',
    nurseryArea: '2 rai',
    motherPlantArea: '1 rai',
    processingArea: '600 sqm',
    dryingArea: '400 sqm',
    storageArea: '350 sqm',
    securityArea: 'Fully CCTV + biometric access',
    expansionCapacity: '8 additional rai planned',
    facilityPhotoUrl: '',
    activeRooms: '12',
    harvestsPerYear: '5',
    avgYieldPerHarvest: '900 kg',
    annualCapacity: '4500 kg',
    currentInventory: '3800 kg',
    projectedInventory: '4500 kg by Q2 2026',
    productionUtilisation: '88',
    maxProductionCapacity: '5000 kg/year',
    cultivationMethod: 'Full-spectrum LED indoor controlled',
    fertiliserProgram: 'Pharmaceutical-grade mineral program',
    nutrientBrands: 'Athena, General Hydroponics',
    pestManagement: 'Strict IPM + clean room protocols',
    ipmProcedures: 'Daily monitoring, HEPA filtration, positive pressure rooms',
    waterSource: 'Purified RO water + UV sterilisation',
    waterTestingFrequency: 'Weekly',
    waterAnalysisFile: 'water_analysis_korat_2025.pdf',
    mainStrains: 'Korat OG, Medical White, Thai Citrus',
    breeder: 'In-house R&D programme',
    geneticLineage: 'Indica-dominant medical strains',
    typicalThc: '20–24%',
    typicalCbd: '0.10–0.20%',
    dominantTerpenes: 'Caryophyllene, Linalool, Myrcene',
    harvestCycle: '9–11 weeks',
    yieldPerSqm: '520g',
    qtyAvailableNow: '3800 kg',
    qtyAvailable30: '900 kg',
    qtyAvailable60: '900 kg',
    qtyAvailable90: '900 kg',
    qtyAvailable180: '3600 kg',
    productPhotoUrl: '',
    coaFiles: 'KoratOG_COA_2025_001.pdf, MedWhite_COA_2025_001.pdf, ThaiCitrus_COA_2025_001.pdf',
    heavyMetalsTested: 'Yes',
    pesticidesTested: 'Yes',
    mycotoxinsTested: 'Yes',
    microbiologyTested: 'Yes',
    waterActivityTested: 'Yes',
    batchTrackingSystem: 'Yes',
    seedToSaleSystem: 'Yes',
    sopsAvailable: 'Yes',
    recallProcedure: 'Yes',
    wasteDisposal: 'Yes',
    employeeTraining: 'Yes',
    securityProtocols: 'Yes',
    visitorProcedures: 'Yes',
    incidentReporting: 'Yes',
    capaProgram: 'Yes',
    internalAudits: 'Yes',
    externalAudits: 'Yes',
    suppliedEU: 'Yes',
    suppliedPharma: 'Yes',
    suppliedGMPProcessors: 'Yes',
    existingSopLibrary: 'Yes',
    existingQA: 'Yes',
    existingQC: 'Yes',
    qualifiedPerson: 'Yes',
    stabilityProgram: 'Yes',
    changeControl: 'Yes',
    deviationProcedures: 'Yes',
    riskManagement: 'Yes',
    documentationControl: 'Yes',
    countriesExported: 'Germany (pilot), Czech Republic (pilot)',
    freightProviders: 'DHL Express, TNT Pharma',
    customsBrokers: 'Thai Customs Pro, EU Pharma Logistics',
    incotermsFamiliarity: 'CIF, DAP, DDP',
    packagingStandards: 'EU pharmaceutical-grade packaging',
    labellingStandards: 'GHS + EU MDR compliant',
    shippingCapacity: 'Up to 2000kg per shipment',
    interestedExclusive: 'Yes',
    interestedNonExclusive: 'Yes',
    interestedEUGMP: 'Yes',
    interestedLongTerm: 'Yes',
    interestedJV: 'Yes',
    monthlyReportingAgreement: 'Yes',
    scoreCompliance: 92,
    scoreDocumentation: 90,
    scoreFacilityQuality: 95,
    scoreProductQuality: 88,
    scoreExportReadiness: 85,
    scoreReliability: 90,
    scoreCommunication: 88,
    scoreScalability: 82,
    scoreGMPReadiness: 86,
  },
]

export const SEED_INVENTORY: InventoryItem[] = [
  {
    id: 'seed-1',
    farmerName: 'Calli Krush',
    farmName: 'Calli Krush',
    farmId: 'farm-1',
    location: 'Buriram, Thailand',
    productName: 'Mango',
    quantityKg: 1000,
    harvestDate: '2025-12-01',
    cureDate: '2025-12-22',
    batchNumber: 'F4-122025',
    thcPct: 26.86,
    cbdPct: 0.10,
    moisturePct: 10.27,
    waterActivity: '0.58',
    qualityGrade: 'A',
    pricePerKg: 45,
    certFileName: 'Mango_COA_F4-122025.pdf',
    photoUrl: '',
    storageConditions: 'Sealed, dark, 18°C, 55% RH',
    notes: 'First harvest of the season. Extra sweet variety.',
    status: 'Pending Review',
    submittedAt: new Date().toISOString(),
    labName: 'Bureau Veritas (Thailand)',
    reportNumber: 'BV-TH-2025-11842',
    testDate: '2025-12-18',
    heavyMetalsStatus: 'pass',
    pesticidesStatus: 'pass',
    microbialStatus: 'pass',
    mycotoxinsStatus: 'pass',
  },
  {
    id: 'seed-2',
    farmerName: 'Calli Krush',
    farmName: 'Calli Krush',
    farmId: 'farm-1',
    location: 'Buriram, Thailand',
    productName: 'Red Dragon',
    quantityKg: 800,
    harvestDate: '2025-12-01',
    cureDate: '2025-12-22',
    batchNumber: 'F4-122025',
    thcPct: 23.02,
    cbdPct: 0.09,
    moisturePct: 11.38,
    waterActivity: '0.59',
    qualityGrade: 'A',
    pricePerKg: 60,
    certFileName: 'Red_Dragon_COA_F4-122025.pdf',
    photoUrl: '',
    storageConditions: 'Sealed, dark, 18°C, 55% RH',
    notes: '',
    status: 'Approved',
    submittedAt: new Date().toISOString(),
    labName: 'Bureau Veritas (Thailand)',
    reportNumber: 'BV-TH-2025-11901',
    testDate: '2025-12-19',
    heavyMetalsStatus: 'pass',
    pesticidesStatus: 'pass',
    microbialStatus: 'pass',
    mycotoxinsStatus: 'fail',
  },
  {
    id: 'seed-3',
    farmerName: 'Calli Krush',
    farmName: 'Calli Krush',
    farmId: 'farm-1',
    location: 'Buriram, Thailand',
    productName: 'Purple Gelato',
    quantityKg: 500,
    harvestDate: '2025-12-01',
    cureDate: '2025-12-22',
    batchNumber: 'F4-122025',
    thcPct: 19.49,
    cbdPct: 0.09,
    moisturePct: 10.61,
    waterActivity: '0.57',
    qualityGrade: 'B',
    pricePerKg: 38,
    certFileName: '',
    photoUrl: '',
    storageConditions: 'Sealed, dark, 18°C, 55% RH',
    notes: '',
    status: 'Missing Document',
    submittedAt: new Date().toISOString(),
  },
]

export function loadInventory(): InventoryItem[] {
  // Supabase mode: return empty so the DB fetch populates state, not stale seed data.
  if (sbConfigured) return []
  const raw = localStorage.getItem(INV_KEY)
  if (raw) return JSON.parse(raw)
  localStorage.setItem(INV_KEY, JSON.stringify(SEED_INVENTORY))
  return SEED_INVENTORY
}

// Never throws. These run inside React effects (App.tsx:117-118) and there is no
// error boundary in the app, so a QuotaExceededError escaping here would blank the
// UI. Returns whether the write actually succeeded — it never reports a success it
// did not achieve.
export function saveInventory(items: InventoryItem[]): boolean {
  return safeSetItem(INV_KEY, JSON.stringify(items))
}

export function loadFarms(): FarmProfile[] {
  // Supabase mode: return empty so the DB fetch populates state, not stale seed data.
  if (sbConfigured) return []
  const raw = localStorage.getItem(FARM_KEY)
  if (raw) return JSON.parse(raw)
  localStorage.setItem(FARM_KEY, JSON.stringify(SEED_FARMS))
  return SEED_FARMS
}

// Never throws — see saveInventory.
export function saveFarms(farms: FarmProfile[]): boolean {
  return safeSetItem(FARM_KEY, JSON.stringify(farms))
}

export function resetDemo() {
  // The removals below are always safe — deleting a browser copy never leaks.
  // The SEED WRITES are demo-only: reachable in Supabase mode via App.tsx:477 ->
  // db.ts resetDemoData(), they would recreate ddp_inventory / ddp_farms in the
  // browser immediately after the guards above stopped them being written.
  if (shouldPersistToBrowser()) {
    safeSetItem(INV_KEY, JSON.stringify(SEED_INVENTORY))
    safeSetItem(FARM_KEY, JSON.stringify(SEED_FARMS))
  }
  localStorage.removeItem(FARM_DRAFT_KEY)
  localStorage.removeItem(REQUIREMENT_OVERRIDE_KEY)
  localStorage.removeItem(RISK_OVERRIDE_KEY)
  localStorage.removeItem(DECISION_KEY)
}

export function loadFarmDraft(): Partial<FarmProfile> | null {
  const raw = localStorage.getItem(FARM_DRAFT_KEY)
  return raw ? (JSON.parse(raw) as Partial<FarmProfile>) : null
}

export function saveFarmDraft(draft: Partial<FarmProfile>) {
  localStorage.setItem(FARM_DRAFT_KEY, JSON.stringify(draft))
}

export function clearFarmDraft() {
  localStorage.removeItem(FARM_DRAFT_KEY)
}

// ── Review Requests ──────────────────────────────────────────────────────────

export const REVIEW_REQUESTS_KEY = 'ddp_review_requests'

export function loadReviewRequests(): ReviewRequest[] {
  try {
    return JSON.parse(localStorage.getItem(REVIEW_REQUESTS_KEY) ?? '[]')
  } catch {
    return []
  }
}

// DEMO MODE ONLY. App.tsx:119 persists review requests on every state change, and
// in Supabase mode they are fetched from farmer_review_requests (App.tsx:161) — so
// this wrote production data into the operator's browser, exactly as the inventory
// and farm effects did. Never throws (see saveInventory).
export function saveReviewRequests(requests: ReviewRequest[]): boolean {
  if (!shouldPersistToBrowser()) return false
  return safeSetItem(REVIEW_REQUESTS_KEY, JSON.stringify(requests))
}

// ── Market Benchmarks (owner-controlled, farmer-visible) ─────────────────────

export const MARKET_BENCHMARKS_KEY = 'ddp_market_benchmarks'

export const SEED_BENCHMARKS: MarketBenchmark[] = [
  { id: 'b1', productType: 'flower', thcRange: '20–25%', priceMin: 35000, priceMax: 55000, unit: 'kg', visibleToFarmers: true },
  { id: 'b2', productType: 'flower', thcRange: '15–20%', priceMin: 20000, priceMax: 35000, unit: 'kg', visibleToFarmers: true },
  { id: 'b3', productType: 'trim', priceMin: 5000, priceMax: 12000, unit: 'kg', visibleToFarmers: true },
  { id: 'b4', productType: 'biomass', priceMin: 3000, priceMax: 8000, unit: 'kg', visibleToFarmers: true },
  { id: 'b5', productType: 'extract', priceMin: 80000, priceMax: 200000, unit: 'kg', visibleToFarmers: true },
]

export function loadMarketBenchmarks(): MarketBenchmark[] {
  // Supabase mode returns EMPTY, exactly as loadInventory()/loadFarms() do.
  //
  // These are PRICE HINTS SHOWN TO REAL FARMERS. This function previously
  // returned SEED_BENCHMARKS unconditionally, and App.tsx seeds its
  // marketBenchmarks state from it at mount in every mode — so a production
  // farmer was shown fictional prices (35,000–55,000 THB/kg flower and four
  // more) before any query ran, and kept seeing them if the real query returned
  // nothing. Fabricated commercial guidance is worse than none: a farmer can act
  // on a price. Empty renders no benchmark panel at all, which is honest.
  if (sbConfigured) return []

  const stored = localStorage.getItem(MARKET_BENCHMARKS_KEY)
  if (stored) {
    try { return JSON.parse(stored) } catch { /* malformed JSON — fall through to seed */ }
  }
  return SEED_BENCHMARKS
}

export function saveMarketBenchmarks(benchmarks: MarketBenchmark[]): void {
  localStorage.setItem(MARKET_BENCHMARKS_KEY, JSON.stringify(benchmarks))
}

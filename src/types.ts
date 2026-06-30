export type Lang = 'en' | 'th'

export type { UserRole, UserProfile } from './services/auth'

export type InventoryStatus = 'Pending Review' | 'Approved' | 'Missing Document' | 'Rejected'

export type FarmStatus =
  | 'Draft'
  | 'Submitted to DDP'
  | 'Under Review'
  | 'More Information Required'
  | 'Approved'
  | 'Watchlist'
  | 'Strategic Partner'
  | 'Rejected'

export type PartnerTier =
  | 'Platinum Partner'
  | 'Gold Partner'
  | 'Silver Partner'
  | 'Watchlist'
  | 'Gold Candidate'
  | 'Pending'

export type Page =
  | 'landing'
  | 'login'
  | 'signup'
  | 'farmer-register'
  | 'farmer-dashboard'
  | 'farmer-onboarding'
  | 'farmer-advanced-profile'
  | 'farmer-my-stock'
  | 'farmer-stock-form'
  | 'farmer-requests'
  | 'farmer-status'
  | 'ddp-overview'
  | 'ddp-farms'
  | 'ddp-farm-review'
  | 'ddp-inventory'
  | 'ddp-inventory-review'
  | 'ddp-master'
  | 'ddp-buyer'

export type StockStatus =
  | 'draft'
  | 'submitted'
  | 'needs_changes'
  | 'approved_internal'
  | 'client_visible'
  | 'reserved'
  | 'sold'
  | 'archived'

export type ProductType = 'flower' | 'trim' | 'biomass' | 'extract' | 'other'

export type TestStatus = 'pass' | 'fail' | 'not_tested' | ''

export interface ReviewRequest {
  id: string
  stockItemId?: string
  farmProfileId?: string
  requestType: 'coa' | 'photo' | 'quantity' | 'price' | 'batch_number' | 'licence' | 'general'
  message: string
  status: 'open' | 'resolved'
  createdBy: string
  createdAt: string
  resolvedAt?: string
  productName?: string
  farmName?: string
}

export interface MarketBenchmark {
  id: string
  productType: string
  thcRange?: string
  priceMin: number
  priceMax: number
  unit: 'g' | 'kg'
  visibleToFarmers: boolean
}

export interface InventoryItem {
  id: string
  farmerName: string
  farmName: string
  farmId?: string
  location: string
  productName: string
  quantityKg: number
  harvestDate: string
  cureDate: string
  batchNumber: string
  thcPct: number
  cbdPct: number
  moisturePct: number
  waterActivity: string
  qualityGrade: string
  pricePerKg: number
  certFileName: string
  photoUrl: string
  storageConditions: string
  notes: string
  status: InventoryStatus
  submittedAt: string
  // Extended stock tracking (all optional to preserve existing records)
  stockStatus?: StockStatus
  productType?: ProductType
  unit?: 'g' | 'kg'
  minimumOrderKg?: number
  totalTerpenesPct?: number
  expiryDate?: string
  clientVisible?: boolean
  coaAvailable?: boolean
  labName?: string
  reportNumber?: string
  sampleName?: string
  testDate?: string
  heavyMetalsStatus?: TestStatus
  pesticidesStatus?: TestStatus
  microbialStatus?: TestStatus
  mycotoxinsStatus?: TestStatus
  photoUrls?: string[]
  farmerNotes?: string
  ownerNotes?: string
  coaStoragePath?: string
}

export interface FarmProfile {
  id: string
  status: FarmStatus
  submittedAt: string
  completionPct: number
  partnerTier: PartnerTier
  // Step 1
  legalBusinessName: string
  tradingName: string
  registrationNumber: string
  taxNumber: string
  dateEstablished: string
  province: string
  district: string
  gpsCoordinates: string
  registeredAddress: string
  operationalAddress: string
  website: string
  facebook: string
  lineId: string
  whatsapp: string
  email: string
  primaryContact: string
  position: string
  mobileNumber: string
  secondaryContact: string
  emergencyContact: string
  // Step 2
  ownerName: string
  nationality: string
  ownershipPct: string
  additionalShareholders: string
  ownershipBreakdown: string
  ultimateBeneficialOwners: string
  parentCompany: string
  subsidiaries: string
  foreignInvestors: string
  strategicPartners: string
  exportPartners: string
  // Step 3
  cultivationLicence: string
  processingLicence: string
  manufacturingLicence: string
  researchLicence: string
  medicalCannabisLicence: string
  exportLicence: string
  importLicence: string
  gmpCert: string
  gapCert: string
  gacpCert: string
  organicCert: string
  isoCerts: string
  otherCerts: string
  documentExpiry: string
  // Step 4
  farmType: string
  totalLandArea: string
  cultivationArea: string
  floweringArea: string
  nurseryArea: string
  motherPlantArea: string
  processingArea: string
  dryingArea: string
  storageArea: string
  securityArea: string
  expansionCapacity: string
  facilityPhotoUrl: string
  // Step 5
  activeRooms: string
  harvestsPerYear: string
  avgYieldPerHarvest: string
  annualCapacity: string
  currentInventory: string
  projectedInventory: string
  productionUtilisation: string
  maxProductionCapacity: string
  cultivationMethod: string
  fertiliserProgram: string
  nutrientBrands: string
  pestManagement: string
  ipmProcedures: string
  waterSource: string
  waterTestingFrequency: string
  waterAnalysisFile: string
  // Step 6
  mainStrains: string
  breeder: string
  geneticLineage: string
  typicalThc: string
  typicalCbd: string
  dominantTerpenes: string
  harvestCycle: string
  yieldPerSqm: string
  qtyAvailableNow: string
  qtyAvailable30: string
  qtyAvailable60: string
  qtyAvailable90: string
  qtyAvailable180: string
  productPhotoUrl: string
  // Step 7
  coaFiles: string
  heavyMetalsTested: string
  pesticidesTested: string
  mycotoxinsTested: string
  microbiologyTested: string
  waterActivityTested: string
  batchTrackingSystem: string
  seedToSaleSystem: string
  sopsAvailable: string
  recallProcedure: string
  wasteDisposal: string
  employeeTraining: string
  securityProtocols: string
  visitorProcedures: string
  incidentReporting: string
  capaProgram: string
  internalAudits: string
  externalAudits: string
  // Step 8
  suppliedEU: string
  suppliedPharma: string
  suppliedGMPProcessors: string
  existingSopLibrary: string
  existingQA: string
  existingQC: string
  qualifiedPerson: string
  stabilityProgram: string
  changeControl: string
  deviationProcedures: string
  riskManagement: string
  documentationControl: string
  countriesExported: string
  freightProviders: string
  customsBrokers: string
  incotermsFamiliarity: string
  packagingStandards: string
  labellingStandards: string
  shippingCapacity: string
  interestedExclusive: string
  interestedNonExclusive: string
  interestedEUGMP: string
  interestedLongTerm: string
  interestedJV: string
  monthlyReportingAgreement: string
  // Registration & pricing extras
  role?: string
  priceNotes?: string
  // DDP internal scores
  scoreCompliance: number
  scoreDocumentation: number
  scoreFacilityQuality: number
  scoreProductQuality: number
  scoreExportReadiness: number
  scoreReliability: number
  scoreCommunication: number
  scoreScalability: number
  scoreGMPReadiness: number
}

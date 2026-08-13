export type Lang = 'en' | 'th'

export type { UserRole, UserProfile } from './services/auth.js'

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

export type ComplianceVerificationTier =
  | 'CULTIVATOR_CLAIMED'
  | 'DDP_DOCUMENTED'
  | 'ADVANCED_DOCUMENTATION_REVIEW'

// ─── Procurement authority model ────────────────────────────────────────────
// Every farm/batch/document claim must be labelled with one of these evidence
// levels. Nothing in the UI may imply "verified" unless the underlying data
// actually supports that level — see deriveDocumentRequirement /
// deriveCoaIntelligence in lib/procurementControl.ts for how each level is
// assigned from real fields (never invented).
export type EvidenceStatus =
  | 'claimed'     // stated by farm/contact, not yet backed by file
  | 'documented'  // supported by a received file/document
  | 'reviewed'    // internally reviewed by DDP for obvious gaps
  | 'verified'    // independently checked/confirmed by a qualified party
  | 'missing'     // required but not received
  | 'rejected'    // unsuitable or failed review
  | 'expired'     // was on file but has passed its validity date

// A DDP staff decision made against a farm, batch, or buyer pack.
export type ProcurementDecision =
  | 'progress'
  | 'hold'
  | 'reject'
  | 'request_documents'
  | 'request_fresh_coa'
  | 'request_inventory_proof'
  | 'escalate_review'

export type DocumentRequirementType =
  | 'farm_identity'
  | 'farm_license'
  | 'coa'
  | 'batch_number'
  | 'inventory_quantity_proof'
  | 'inventory_photos'
  | 'inventory_video'
  | 'storage_evidence'
  | 'chain_of_custody'
  | 'gacp_evidence'
  | 'gmp_evidence'
  | 'export_readiness_docs'
  | 'responsible_contact'

export interface DocumentRequirement {
  farmId: string
  batchId?: string
  type: DocumentRequirementType
  status: EvidenceStatus
  notes?: string
  lastUpdated?: string
  /** Filename, storage path, or other pointer to the underlying evidence, if any. */
  reference?: string
}

// Structured COA fields for procurement review. Populated only from data
// already present on an InventoryItem — see deriveCoaIntelligence(). If no
// real parsed value exists for a field, it is left undefined rather than
// invented.
export interface CoaIntelligence {
  batchId: string
  sampleName?: string
  strainName?: string
  batchNumber?: string
  reportNumber?: string
  labName?: string
  reportDate?: string
  manufacturingDate?: string
  expiryDate?: string
  totalThcPercent?: number
  totalCbdPercent?: number
  totalTerpenesPercent?: number
  moisturePercent?: number
  pesticidesStatus?: TestStatus
  heavyMetalsStatus?: TestStatus
  mycotoxinsStatus?: TestStatus
  microbialStatus?: TestStatus
  sourceDocument?: string
  evidenceStatus: EvidenceStatus
  redFlags: string[]
}

export type RiskSeverity = 'low' | 'medium' | 'high' | 'blocker'
export type RiskStatus = 'open' | 'in_review' | 'resolved' | 'accepted'

export type ComplianceSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type ComplianceStatus = 'open' | 'in_review' | 'blocked' | 'resolved' | 'dismissed'

export type LegalUpdateStatus =
  | 'new'
  | 'needs_review'
  | 'reviewed'
  | 'rule_suggested'
  | 'sent_to_legal'
  | 'archived'
  | 'rejected'

export type LegalUpdateAffectedArea =
  | 'Thai cultivation'
  | 'Thai cannabis control'
  | 'Thai export'
  | 'Czech import'
  | 'EU pharmaceutical standards'
  | 'GMP/GACP/GDP'
  | 'Data protection'
  | 'Buyer licensing'
  | 'Farm licensing'
  | 'COA/testing'
  | 'Chain of custody'
  | 'Marketing/claims'
  | 'Other'

export type ComplianceRuleEntityType =
  | 'farm'
  | 'batch'
  | 'coa'
  | 'buyer'
  | 'document'
  | 'shipment'
  | 'platform_claim'
  | 'data_protection'

export type ComplianceRuleStatus =
  | 'draft'
  | 'suggested'
  | 'approved'
  | 'active'
  | 'paused'
  | 'retired'
  | 'rejected'

export type ExportReadinessStatus =
  | 'not_ready'
  | 'missing_documents'
  | 'needs_compliance_review'
  | 'buyer_ready_for_discussion'
  | 'export_readiness_incomplete'
  | 'ready_for_legal_review'
  | 'human_approved'
  | 'blocked'

// ─── Source governance & tiering (Phase B) ──────────────────────────────────
//
// Authority tier of a regulatory source. Tier 3 is an intelligence SIGNAL only
// and must never be treated as direct authority in downstream compliance state
// — see src/lib/complianceSourceGovernance.ts for the enforced guard.
export type RegulatorySourceTier = 1 | 2 | 3

export type RegulatorySourceAuthorityType =
  | 'primary_regulator'
  | 'ministry'
  | 'official_gazette'
  | 'court'
  | 'standards_body'
  | 'industry_association'
  | 'news_media'
  | 'aggregator'
  | 'other'

export type RegulatorySourceCategory =
  | 'cultivation'
  | 'export_import'
  | 'pharmaceutical'
  | 'data_protection'
  | 'licensing'
  | 'testing_quality'
  | 'general'

export type RegulatorySourceMonitoringMethod =
  | 'rss'
  | 'atom'
  | 'html'
  | 'pdf'
  | 'government_api'
  | 'manual'

export interface RegulatorySource {
  id: string
  name: string
  jurisdiction: string
  sourceType: string
  url: string
  isActive: boolean
  lastCheckedAt?: string | null
  // Governance fields (Phase B). Optional on the type so pre-migration-26 rows
  // and existing call sites keep compiling; the DB defaults them on write.
  tier?: RegulatorySourceTier | null
  authorityType?: RegulatorySourceAuthorityType | null
  category?: RegulatorySourceCategory | null
  monitoringMethod?: RegulatorySourceMonitoringMethod | null
  priority?: number | null
  createdAt: string
  updatedAt: string
}

export interface LegalUpdate {
  id: string
  sourceId?: string | null
  title: string
  jurisdiction: string
  sourceName: string
  sourceUrl: string
  publishedAt?: string | null
  detectedAt: string
  rawText: string
  summary: string
  affectedAreas: LegalUpdateAffectedArea[]
  aiRiskLevel?: ComplianceSeverity | null
  status: LegalUpdateStatus
  reviewerNotes: string
  // Provenance (Phase A / migration 25). Optional so manually pasted updates,
  // which carry none, keep compiling and reading cleanly.
  contentHash?: string | null
  canonicalUrl?: string | null
  externalDocumentId?: string | null
  sourceTier?: RegulatorySourceTier | null
  ingestionRunId?: string | null
  ingestionItemKey?: string | null
  createdAt: string
  updatedAt: string
}

// ─── Ingestion evidence (Phase A / migration 25, Phase C runner) ─────────────

export type IngestionRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped'
export type IngestionRunTrigger = 'scheduled' | 'manual' | 'backfill'

export interface WatchtowerIngestionRun {
  id: string
  sourceId: string | null
  sourceNameSnapshot: string
  sourceUrlSnapshot: string
  sourceTierSnapshot: RegulatorySourceTier | null
  connectorKind: string
  triggerType: IngestionRunTrigger
  actorType: 'admin' | 'system' | 'scheduler'
  status: IngestionRunStatus
  failureReason: string | null
  errorDetail: string | null
  startedAt: string
  finishedAt: string | null
  itemsSeen: number
  itemsNew: number
  itemsDuplicate: number
  itemsUnchanged: number
  itemsFailed: number
  createdAt: string
  updatedAt: string
}

export interface WatchtowerIngestionItem {
  id: string
  runId: string
  sourceId: string | null
  itemKey: string
  externalDocumentId: string | null
  canonicalUrl: string | null
  title: string
  publishedAt: string | null
  contentHash: string | null
  normalizedLength: number | null
  dedupDecision: string
  dedupMatchedLegalUpdateId: string | null
  legalUpdateId: string | null
  failureReason: string | null
  errorDetail: string | null
  createdAt: string
}

export interface ComplianceReview {
  id: string
  legalUpdateId?: string | null
  alertId?: string | null
  ruleId?: string | null
  title: string
  reviewType: 'legal_update' | 'alert' | 'rule' | 'readiness' | 'document_status'
  status: 'pending' | 'in_review' | 'reviewed' | 'sent_to_legal' | 'rejected' | 'archived'
  riskLevel: ComplianceSeverity
  affectedEntities: string[]
  summary: string
  recommendedAction: string
  reviewerNotes: string
  decision?: string | null
  reviewedBy?: string | null
  reviewedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface ComplianceRule {
  id: string
  ruleCode: string
  title: string
  description: string
  jurisdiction?: string | null
  entityType: ComplianceRuleEntityType
  severity: ComplianceSeverity
  isBlocking: boolean
  status: ComplianceRuleStatus
  sourceLegalUpdateId?: string | null
  approvedBy?: string | null
  approvedAt?: string | null
  /**
   * Effective dating, added to the table by migration 41 but absent from this
   * interface until rule enforcement needed it. `effective_from` is NOT NULL
   * DEFAULT current_date in the database, so a row always has one; it is
   * optional here only because a client projection may omit the column.
   * Optional/absent must therefore be read as "unknown", never as "not yet in
   * force" — see isRuleWithinEffectiveWindow.
   */
  effectiveFrom?: string | null
  effectiveTo?: string | null
  createdAt: string
  updatedAt: string
}

export interface ComplianceAlert {
  id: string
  entityType: ComplianceRuleEntityType
  entityId: string
  ruleId?: string | null
  legalUpdateId?: string | null
  alertTitle: string
  alertDetail: string
  severity: ComplianceSeverity
  status: ComplianceStatus
  createdAt: string
  resolvedAt?: string | null
  resolutionNotes?: string | null
}

export interface ComplianceEntityStatus {
  id: string
  entityType: ComplianceRuleEntityType
  entityId: string
  readinessStatus: ExportReadinessStatus
  riskLevel: ComplianceSeverity
  missingRequirements: string[]
  blockingAlertCount: number
  lastEvaluatedAt: string
  createdAt: string
  updatedAt: string
}

export interface ComplianceAuditLog {
  id: string
  actorType: 'admin' | 'ai_assistant' | 'system' | 'legal_reviewer'
  actorId?: string | null
  actorName: string
  action:
    | 'legal_update_created'
    | 'legal_update_reviewed'
    | 'rule_suggested'
    | 'rule_approved'
    | 'rule_paused'
    | 'rule_retired'
    | 'alert_created'
    | 'alert_resolved'
    | 'readiness_status_changed'
    | 'document_status_changed'
    | 'sent_to_legal_review'
    | 'reviewer_note_added'
    | 'rule_rejected'
    | 'legal_update_archived'
    | 'alert_dismissed'
  entityType: string
  entityId?: string | null
  beforeState?: unknown
  afterState?: unknown
  reason?: string | null
  createdAt: string
}

export interface RiskRegisterEntry {
  riskId: string
  farmId?: string
  batchId?: string
  severity: RiskSeverity
  issue: string
  requiredAction: string
  owner: string
  status: RiskStatus
  evidenceStatus: EvidenceStatus
}

export type Page =
  | 'landing'
  // ── Public corporate pages ────────────────────────────────────────────────
  // The only pages besides the landing page that are approved for public search
  // indexing. They exist because the search-exposure programme's binding entry
  // condition was that at least two real corporate pages exist to index: until
  // they did, the whole programme governed exactly one URL.
  //
  // They carry no operational data of any kind. Everything they state is either
  // copy already approved on the landing page or a description of behaviour
  // that can be read out of this repository — see lib/publicPageMetadata.ts for
  // the indexability register and pages/public/* for the content.
  | 'about'
  | 'contact'
  | 'privacy'
  | 'terms'
  // Governance (handoff §11) — the destination for the compliance argument the
  // homepage used to open with. Indexable: it is the page a compliance officer
  // searches for, and it states only behaviour that can be read out of this
  // repository and the live schema.
  | 'governance'
  // The German-language buyer page at /de.
  //
  // The site speaks English and Thai. Thai serves the SUPPLY side — Thai farms
  // reached by QR code and WhatsApp. Both demand-side markets the company names
  // (Germany, Czechia) had no language on the site at all, while a German buyer
  // searches in German.
  //
  // It is deliberately NOT a third app language. Adding 'de' to Lang would mean
  // translating every authenticated screen in the application; this is one
  // public page that stands on its own, and it states nothing that is not
  // already published in English on the landing page.
  | 'de-buyer'
  // The Czech-language buyer page at /cs. Same construction as /de: a
  // standalone public document, not a third app language.
  | 'cs-buyer'
  // The regulatory-updates hub at /regulatory-updates.
  // The Thai-language supplier page at /th/suppliers. Acquisition side: content
  // a Thai producer searches for, linking to /farmer, which stays a noindexed
  // form because a form has nothing to rank.
  | 'th-supplier'
  | 'regulatory-hub'
  // One published entry. Unlike every other member here, this does NOT identify
  // a single URL: entries are files on disk, one or two new ones a week, so the
  // slug comes from the path rather than the enum. The member says "render an
  // entry"; content/regulatoryEntries.entryForPath says which one.
  | 'regulatory-entry'
  // The buyer's own surface. Production has admitted `buyer` as a profile role
  // since migration 39 and carries the organisation tables, but no page existed
  // for one to land on — so `resolvePostLoginDecision` fell a buyer through to
  // `default:` and signed them straight back out. The substrate was built and
  // the door was locked from the inside.
  | 'buyer-dashboard'
  | 'login'
  // Where a Supabase invite / password-recovery link lands. Reached from the
  // captured redirect (lib/authRedirect.ts), never from a nav affordance.
  | 'set-password'
  | 'forgot-password'
  | 'farmer-register'
  | 'farmer-dashboard'
  | 'farmer-onboarding'
  | 'farmer-advanced-profile'
  | 'farmer-my-stock'
  | 'farmer-stock-form'
  | 'farmer-requests'
  | 'farmer-status'
  // Where a farm reads DDP's decisions on the documents it uploaded — including
  // the clarification a reviewer asked for (migration 65).
  | 'farmer-evidence'
  | 'ddp-overview'
  | 'ddp-farms'
  | 'ddp-farm-review'
  | 'ddp-inventory'
  | 'ddp-inventory-review'
  | 'ddp-master'
  | 'ddp-buyer'
  | 'ddp-missing-documents'
  | 'ddp-coa-intelligence'
  | 'ddp-risk-register'
  | 'ddp-compliance-watchtower'
  | 'ddp-operations-desk'
  | 'ddp-access-requests'
  // Onboarding a buyer is a form, not a triage action: there is no buyer
  // self-registration, so unlike a farmer there is no enquiry row to provision
  // FROM. Hence its own page rather than a control on 'ddp-access-requests'.
  | 'ddp-buyer-provisioning'
  // The read-and-decide half of the evidence register. Separate from
  // 'ddp-missing-documents', which reports what is ABSENT; this one reviews
  // what has actually arrived.
  | 'ddp-document-review'

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

export type CarbonProgrammeStatus =
  | 'not_reviewed'
  | 'admin_reviewing'
  | 'eligible_internal'
  | 'excluded_by_farmer'
  | 'withdrawn_by_farmer'
  | 'ineligible'

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

/**
 * The currencies production will accept on a batch price.
 *
 * Mirrors the live CHECK `inventory_batches_price_currency_allowed`, verified
 * against production 2026-08-06:
 *
 *   price_currency IS NULL OR price_currency = ANY (ARRAY['THB','USD','EUR'])
 *
 * A companion CHECK, `inventory_batches_price_requires_currency`, refuses any
 * row that carries a price without one. Widening this list is a database
 * change first — the constraint is the authority, not this type.
 */
export const BATCH_PRICE_CURRENCIES = ['THB', 'USD', 'EUR'] as const
export type BatchPriceCurrency = (typeof BATCH_PRICE_CURRENCIES)[number]

/**
 * Thai baht. The owner-stated pricing currency for DDP, and the only one the
 * product offers today — there is no currency control on the batch form, so
 * every batch a farmer submits is priced in THB.
 */
export const DEFAULT_BATCH_PRICE_CURRENCY: BatchPriceCurrency = 'THB'

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
  /**
   * The currency `pricePerKg` is stated in. Optional on the type because
   * records created before the column existed do not carry one; the write
   * path in `db.ts` always sends a value, because production refuses a priced
   * row without it.
   */
  priceCurrency?: BatchPriceCurrency
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
  /**
   * Browser-session photo previews as base64 `data:` URLs.
   *
   * These are NOT durable and are deliberately never written to the database —
   * a single phone photo is 500 KB+ of base64. They exist so the farmer can see
   * what they attached before submitting.
   *
   * The durable record is `storedPhotos` below, backed by the private
   * `farmer-photos` storage bucket. Before that path existed, every attached
   * photo was silently discarded on save.
   */
  photoUrls?: string[]
  /**
   * Photos actually on file, as rows in `public.farmer_photos`. Populated on
   * load from the database; each carries a storage path that must be signed to
   * be viewed (the bucket is private).
   */
  storedPhotos?: StoredPhoto[]
  farmerNotes?: string
  ownerNotes?: string
  coaStoragePath?: string
}

/** Photo types accepted by `public.farmer_photos.photo_type` (FARMER_MVP_MIGRATION). */
export type BatchPhotoType = 'product' | 'packaging' | 'batch_label' | 'facility' | 'other'

/**
 * A photo durably on file — one row of `public.farmer_photos`.
 *
 * `storagePath` is a path inside the PRIVATE `farmer-photos` bucket, not a
 * fetchable URL. It must be exchanged for a short-lived signed URL at display
 * time. Storing a signed URL would be wrong: they expire, so a persisted one is
 * a link that works today and silently breaks later.
 */
/**
 * `farmer_documents.review_status` — the CHECK admits exactly these four.
 *
 * `awaiting_clarification` (migration 65) is the reasoned non-decision: an
 * administrator has examined the evidence and can responsibly neither accept
 * nor reject it. It is NOT a weaker acceptance. Nothing in the product may
 * treat it as verified, compliant, export-ready or buyer-visible.
 */
export type DocumentReviewStatus =
  | 'pending'
  | 'awaiting_clarification'
  | 'accepted'
  | 'rejected'

/** The three states that are an actual decision, each requiring a human and a note. */
export const DOCUMENT_REVIEW_DECISIONS = [
  'awaiting_clarification',
  'accepted',
  'rejected',
] as const satisfies readonly DocumentReviewStatus[]

/**
 * One row of public.farmer_document_reviews — the append-only history.
 *
 * The document row carries only the CURRENT status and note; the next decision
 * overwrites both. This is the record that cannot be overwritten, and it is
 * what makes a review defensible rather than merely displayed.
 */
export interface DocumentReviewEvent {
  id: string
  documentId: string
  previousStatus: DocumentReviewStatus
  newStatus: DocumentReviewStatus
  reviewNote: string
  /** Taken from auth.uid() by the database; never chosen by the caller. */
  reviewedBy: string
  reviewedAt: string
}

/** `farmer_documents.document_type` — likewise CHECK-constrained. */
export type FarmerDocumentType = 'coa' | 'licence' | 'photo' | 'other'

/**
 * A row of the evidence register, public.farmer_documents.
 *
 * `sha256Hex` is integrity-since-upload and nothing more: it proves the stored
 * bytes are the bytes DDP received. It does NOT establish that a certificate is
 * authentic or that the laboratory named on it produced it. Any surface
 * rendering this field must say so — it is the easiest false claim in the
 * product to make by accident.
 */
export interface FarmerDocument {
  id: string
  farmId?: string
  batchId?: string
  documentType: FarmerDocumentType
  fileName?: string
  /** Storage PATH, never a signed URL — a persisted signed URL expires. */
  storagePath?: string
  sha256Hex?: string
  sha256RecordedAt?: string
  reviewStatus: DocumentReviewStatus
  /**
   * The reason given for the CURRENT reviewStatus (migration 65). Overwritten by
   * the next decision — `DocumentReviewEvent` is the authoritative history.
   */
  reviewNote?: string
  uploadedAt: string
  reviewedAt?: string
  /** Set by migration 64's trigger from auth.uid(); never chosen by the caller. */
  reviewedBy?: string
  /**
   * What the certificate says about itself.
   *
   * These columns have existed since the COA work and nothing selected them, so
   * the review screen could not show a reviewer what they were being asked to
   * judge — and could not surface the contradiction between the sample the
   * report names and the batch the document is filed against, which is the
   * commonest reason a certificate is in the queue at all.
   */
  labName?: string
  reportNumber?: string
  sampleName?: string
}

export interface StoredPhoto {
  id: string
  batchId: string
  farmId?: string
  photoType: BatchPhotoType
  storagePath: string
  caption?: string
  createdAt: string
}

export interface FarmProfile {
  id: string
  status: FarmStatus
  submittedAt: string
  completionPct: number
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
  picsCert: string
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
  // Carbon programme (farmer exclusion / DDP internal review)
  carbonProgrammeStatus?: CarbonProgrammeStatus
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

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComplianceAlert,
  ComplianceAuditLog,
  ComplianceReview,
  ComplianceRule,
  ComplianceRuleEntityType,
  ComplianceSeverity,
  ComplianceStatus,
  FarmProfile,
  InventoryItem,
  LegalUpdate,
  LegalUpdateAffectedArea,
  RegulatorySource,
  UserProfile,
} from '../../types'
import {
  AFFECTED_AREA_OPTIONS,
  COMPLIANCE_SEVERITIES,
  RULE_ENTITY_TYPES,
  formatComplianceLabel,
  isEnforcedRuleStatus,
  isRuleEnforced,
} from '../../lib/complianceRules'
import { deriveRuleBasedComplianceAlerts, mergeComplianceAlerts } from '../../lib/complianceAlerts'
import { COMPLIANCE_ALERTS_STORAGE_KEY, loadStoredComplianceAlerts, COMPLIANCE_RULES_STORAGE_KEY, loadStoredComplianceRules } from '../../lib/complianceLocalAlerts'
import { deriveExportReadiness } from '../../lib/complianceScoring'
import { guardAiDraftedFields } from '../../lib/aiComplianceGuard'
import * as repo from '../../lib/complianceRepository'
import * as sourceRegistry from '../../lib/complianceSourceRegistry'
import { SUPPORTED_SOURCE_TYPES, deriveRegulatorySourceStatus, type RegulatorySourceStatus } from '../../lib/complianceSourceRegistry'
import { prepareMonitoringLegalUpdateIntake, decideDraftCreation, type MonitoringDecision, type SourceContentSnapshot } from '../../lib/complianceSourceMonitoring'
import {
  evaluateCannamonitorPolicy,
  evaluateCannamonitorManualIntakeGate,
  CANNAMONITOR_REVIEW_HEADLINE,
  CANNAMONITOR_NON_AUTHORITATIVE_NOTICE,
  CANNAMONITOR_DETECTION_LIMITATION,
} from '../../lib/complianceCannamonitorPolicy'
import {
  runManualRssMonitoring,
  evaluateManualMonitoringEligibility,
  canStartManualRun,
  runPastedMonitoringDecision,
  type ManualMonitoringRunResult,
} from '../../lib/complianceManualMonitoring'
import { createBrowserRssFetch } from '../../lib/browserRssFetch'
import { createLocalStorageMonitoringSnapshotRepository } from '../../lib/complianceMonitoringSnapshotStore'
import {
  baselineToPreviousSnapshots,
  buildBaselineCandidate,
  decideBaselineSave,
  nextBaselineVersion,
  type MonitoringBaseline,
} from '../../lib/complianceMonitoringSnapshot'
import type { AiDraftSummary } from '../../lib/complianceAiSummarisation'
import type { ComplianceAiSummaryProvider } from '../../lib/aiComplianceProvider'
import {
  evaluateAiSummaryEligibility,
  runAiDraftSummary,
} from '../../lib/watchtowerAiSummary'
import { createComplianceAiSummaryHttpClient } from '../../lib/complianceAiSummaryClient'
import { isSupabaseConfigured } from '../../lib/supabase'
import { getSession } from '../../services/auth'
import {
  SUPPORTED_SOURCE_TIERS,
  SUPPORTED_AUTHORITY_TYPES,
  SUPPORTED_SOURCE_CATEGORIES,
  SUPPORTED_MONITORING_METHODS,
  SOURCE_TIER_LABELS,
} from '../../lib/complianceSourceGovernance'
import { WatchtowerIngestionPanel } from '../../components/admin/WatchtowerIngestionPanel'
import { listMissingStarterSources } from '../../lib/watchtowerStarterSources'

// Phase 2I — manual AI draft-summary integration, wired to the secure HTTP
// client adapter. This component holds NO vendor SDK, endpoint, or credential:
// the adapter speaks only to our own authenticated Vercel Function
// (/api/compliance/ai-summary), attaching the caller's Supabase session token;
// the server verifies the token, requires a ddp_admin profile, and runs the
// existing guarded summarisation flow. When Supabase is not configured the
// provider is `null`, so the action stays safely disabled. A draft is always
// transient and always requires human legal review; the AI can never approve,
// certify, create a rule, or enforce anything.
const AI_SUMMARY_PROVIDER: ComplianceAiSummaryProvider | null = isSupabaseConfigured
  ? createComplianceAiSummaryHttpClient({
      getAccessToken: async () => (await getSession())?.access_token ?? null,
    })
  : null

interface Props {
  farms: FarmProfile[]
  inventory: InventoryItem[]
  currentUser?: UserProfile | null
}

type WatchtowerTab = 'monitor' | 'monitoring-queue' | 'sources' | 'ingestion' | 'queue' | 'rules' | 'readiness' | 'alerts' | 'audit'

const STORAGE = {
  legalUpdates: 'ddp_compliance_legal_updates',
  reviews: 'ddp_compliance_reviews',
  rules: COMPLIANCE_RULES_STORAGE_KEY,
  alerts: COMPLIANCE_ALERTS_STORAGE_KEY,
  audit: 'ddp_compliance_audit_log',
  sources: 'ddp_compliance_regulatory_sources',
  monitoringSnapshots: 'ddp_compliance_monitoring_snapshots',
}

const TABS: Array<{ id: WatchtowerTab; label: string }> = [
  { id: 'monitor', label: 'Legal Change Monitor' },
  { id: 'monitoring-queue', label: 'Monitoring Queue' },
  { id: 'sources', label: 'Source Registry' },
  { id: 'ingestion', label: 'Ingestion Runs' },
  { id: 'queue', label: 'Review Queue' },
  { id: 'rules', label: 'Compliance Rules' },
  { id: 'readiness', label: 'Export Readiness' },
  { id: 'alerts', label: 'Compliance Alerts' },
  { id: 'audit', label: 'Audit Log' },
]

// Reuses existing status-pill CSS classes (no new CSS added). ARCHIVED is
// mapped for type completeness even though deriveRegulatorySourceStatus()
// never currently returns it — see that function's own comment.
const SOURCE_STATUS_CLASS: Record<RegulatorySourceStatus, string> = {
  ACTIVE: 'status-verified',
  DISABLED: 'status-hold',
  TEST: 'status-claimed',
  ARCHIVED: 'status-missing',
}

const SEVERITY_CLASS: Record<ComplianceSeverity, string> = {
  info: 'badge-gray',
  low: 'badge-gray',
  medium: 'badge-pending',
  high: 'badge-risk-high',
  critical: 'badge-rejected',
}

const ALERT_STATUS_CLASS: Record<ComplianceStatus, string> = {
  open: 'status-review-pending',
  in_review: 'status-reviewed',
  blocked: 'status-reject',
  resolved: 'status-verified',
  dismissed: 'status-claimed',
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function saveStored<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function hydrateLocalSourcesWithStarterSeed(existingSources: RegulatorySource[]): RegulatorySource[] {
  const missing = listMissingStarterSources(existingSources)
  if (missing.length === 0) return existingSources

  const now = new Date().toISOString()
  const seeded: RegulatorySource[] = missing.map((source, index) => ({
    id: makeId(`source-seed-${index}`),
    name: source.name,
    jurisdiction: source.jurisdiction,
    sourceType: source.sourceType,
    url: source.url,
    isActive: source.isActive ?? true,
    lastCheckedAt: null,
    tier: source.tier,
    authorityType: source.authorityType,
    category: source.category,
    monitoringMethod: source.monitoringMethod,
    priority: source.priority,
    createdAt: now,
    updatedAt: now,
  }))
  return [...seeded, ...existingSources]
}

function riskFromAreas(areas: LegalUpdateAffectedArea[]): ComplianceSeverity {
  if (areas.some(area => area === 'Thai export' || area === 'Czech import' || area === 'EU pharmaceutical standards')) return 'high'
  if (areas.some(area => area === 'COA/testing' || area === 'Farm licensing' || area === 'Buyer licensing')) return 'medium'
  if (areas.length === 0) return 'info'
  return 'low'
}

function entityTypeFromAreas(areas: LegalUpdateAffectedArea[]): ComplianceRuleEntityType {
  if (areas.includes('Farm licensing') || areas.includes('Thai cultivation')) return 'farm'
  if (areas.includes('COA/testing')) return 'coa'
  if (areas.includes('Buyer licensing')) return 'buyer'
  if (areas.includes('Thai export') || areas.includes('Czech import')) return 'shipment'
  if (areas.includes('Marketing/claims')) return 'platform_claim'
  if (areas.includes('Data protection')) return 'data_protection'
  return 'document'
}

function statusText(value: string): string {
  return formatComplianceLabel(value)
}

// Safe, non-overstating labels for a manual feed-check decision. The
// changed/first-seen case is explicitly framed as pending human review — it
// never asserts a legal change is confirmed, compliant, approved, or enforced.
function manualDecisionLabel(kind: MonitoringDecision['kind']): string {
  switch (kind) {
    case 'unchanged': return 'No change since last check'
    case 'duplicate': return 'Duplicate item (already seen this check)'
    case 'invalid_source': return 'Invalid or empty item — skipped'
    case 'changed_pending_review': return 'Change detected — pending human review'
    case 'error': return 'Error processing item'
    default: return String(kind)
  }
}

// Administrative, plain-language message for a manual run error/ineligibility.
// Never displays a stack trace; the machine-readable code is preserved
// separately for developer inspection.
function manualRunErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not_https': return 'Source URL is not HTTPS — the check was not performed.'
    case 'off_allowlist': return 'Source host is not on the connector allowlist — the check was not performed.'
    case 'url_unsafe': return 'Source URL is unsafe (private/loopback/metadata address or disallowed port).'
    case 'unsupported_connector': return 'This source is not an RSS/Atom feed.'
    case 'inactive_source': return 'This source is inactive.'
    case 'invalid_url': return 'Source URL is missing or not a valid http(s) URL.'
    case 'timeout': return 'The feed request timed out.'
    case 'oversized_response': return 'The feed response exceeded the maximum allowed size.'
    case 'invalid_content_type': return 'The response was not an RSS/Atom feed (unexpected content type).'
    case 'redirect_blocked': return 'The request was redirected; redirects are not followed for safety.'
    case 'fetch_failed': return 'Could not retrieve the feed (network or CORS error).'
    case 'malformed_feed': return 'The feed XML was malformed.'
    case 'not_a_feed': return 'The response was not an RSS or Atom feed.'
    default: return 'The feed check could not be completed.'
  }
}

// Single localStorage-backed technical-baseline repository for the admin
// session. Phase 2E persists monitoring baselines in the browser only — they
// are technical feed-checksum evidence, never legal/compliance state, and this
// is not a Supabase table. Nothing here touches the compliance database.
const monitoringSnapshotRepo = createLocalStorageMonitoringSnapshotRepository()

export default function DDPComplianceWatchtower({ farms, inventory, currentUser }: Props) {
  const [tab, setTab] = useState<WatchtowerTab>('monitor')
  const [legalUpdates, setLegalUpdates] = useState<LegalUpdate[]>(() => (repo.isSupabaseConfigured ? [] : loadStored(STORAGE.legalUpdates, [])))
  const [reviews, setReviews] = useState<ComplianceReview[]>(() => (repo.isSupabaseConfigured ? [] : loadStored(STORAGE.reviews, [])))
  const [rules, setRules] = useState<ComplianceRule[]>(() => (repo.isSupabaseConfigured ? [] : loadStoredComplianceRules()))
  const [storedAlerts, setStoredAlerts] = useState<ComplianceAlert[]>(() => (repo.isSupabaseConfigured ? [] : loadStoredComplianceAlerts()))
  const [auditLog, setAuditLog] = useState<ComplianceAuditLog[]>(() => (repo.isSupabaseConfigured ? [] : loadStored(STORAGE.audit, [])))
  const [sources, setSources] = useState<RegulatorySource[]>(() => (
    repo.isSupabaseConfigured ? [] : hydrateLocalSourcesWithStarterSeed(loadStored(STORAGE.sources, []))
  ))
  const [openReadinessId, setOpenReadinessId] = useState<string | null>(null)

  const [initialLoading, setInitialLoading] = useState(repo.isSupabaseConfigured)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [legalForm, setLegalForm] = useState({
    title: '',
    jurisdiction: '',
    sourceName: '',
    sourceUrl: '',
    publishedAt: '',
    rawText: '',
    summary: '',
    affectedAreas: [] as LegalUpdateAffectedArea[],
    notes: '',
  })

  const [alertForm, setAlertForm] = useState({
    entityType: 'document' as ComplianceRuleEntityType,
    entityId: '',
    alertTitle: '',
    alertDetail: '',
    severity: 'medium' as ComplianceSeverity,
    linkedRuleId: '',
  })

  const [sourceForm, setSourceForm] = useState({
    name: '',
    jurisdiction: '',
    sourceType: SUPPORTED_SOURCE_TYPES[0] as string,
    url: '',
    // Governance (Phase B). Defaults mirror the conservative DB default
    // (Tier-3 signal): a source is never authoritative unless promoted here.
    tier: 3 as (typeof SUPPORTED_SOURCE_TIERS)[number],
    authorityType: 'aggregator' as (typeof SUPPORTED_AUTHORITY_TYPES)[number],
    category: 'general' as (typeof SUPPORTED_SOURCE_CATEGORIES)[number],
    monitoringMethod: 'manual' as (typeof SUPPORTED_MONITORING_METHODS)[number],
    priority: 100,
  })
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)

  // Monitoring Queue — manual-only. No source is ever fetched automatically;
  // an admin pastes what they retrieved themselves and runs the Phase 1D
  // monitoring skeleton against it. monitoringSnapshots holds the last
  // snapshot seen per sourceId purely so repeat checks can detect
  // unchanged/changed — it is local UI state (persisted to localStorage in
  // demo mode only), not a new backend table.
  const [monitoringSourceId, setMonitoringSourceId] = useState('')
  const [monitoringContent, setMonitoringContent] = useState('')
  const [monitoringDecision, setMonitoringDecision] = useState<MonitoringDecision | null>(null)
  const [monitoringSnapshots, setMonitoringSnapshots] = useState<Record<string, SourceContentSnapshot>>(() => loadStored(STORAGE.monitoringSnapshots, {}))
  const [monitoringBusy, setMonitoringBusy] = useState(false)

  // Manual RSS/Atom feed check (Phase 2D). All transient, in-memory only:
  // rssFeedSnapshots is NOT persisted to localStorage or Supabase — repeat
  // checks within this session can detect unchanged/changed, and it resets on
  // reload. A run happens ONLY from the "Check feed" button handler below;
  // nothing here runs on mount, on a timer, or on a schedule.
  const [rssCheckSourceId, setRssCheckSourceId] = useState<string | null>(null)
  const [rssCheckBusy, setRssCheckBusy] = useState(false)
  const [rssCheckResult, setRssCheckResult] = useState<ManualMonitoringRunResult | null>(null)
  // Phase 2E technical baselines: the current baseline a check compared against,
  // the source's baseline history, and whether the check used a saved baseline.
  const [rssSaveBusy, setRssSaveBusy] = useState(false)
  const [rssComparedBaseline, setRssComparedBaseline] = useState<MonitoringBaseline | null>(null)
  const [rssBaselineHistory, setRssBaselineHistory] = useState<MonitoringBaseline[]>([])
  // Phase 2F draft creation: in-progress guard + the set of feed-item stable ids
  // a draft has already been created for this session (prevents duplicates).
  const [rssDraftBusy, setRssDraftBusy] = useState(false)
  const [rssDraftedItemIds, setRssDraftedItemIds] = useState<Set<string>>(() => new Set())

  // Phase 2H manual AI draft summary: transient state only. `aiDraft` is never
  // persisted and never written back onto legalUpdate.summary — it is cleared on
  // discard, on a fresh generation, and whenever its update is no longer a 'new'
  // draft. `aiRequestUpdateIdRef` records the update id the in-flight request was
  // started for, so a late provider result for a since-changed selection is
  // discarded (stale_selection) rather than shown against the wrong update.
  const [aiDraft, setAiDraft] = useState<AiDraftSummary | null>(null)
  const [aiDraftBusy, setAiDraftBusy] = useState(false)
  const [aiGeneratingUpdateId, setAiGeneratingUpdateId] = useState<string | null>(null)
  const [aiDraftMessage, setAiDraftMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const aiRequestUpdateIdRef = useRef<string | null>(null)
  const starterSeedAttemptedRef = useRef(false)

  const actorName = currentUser?.displayName || currentUser?.email || 'DDP Admin'
  const actorId = currentUser?.id ?? 'local-admin'
  const isSupabaseAdmin = repo.isSupabaseConfigured && !!currentUser && currentUser.role === 'ddp_admin'

  function actorNameForId(id: string | null): string {
    if (id && currentUser?.id === id) return actorName
    return 'DDP Admin'
  }

  useEffect(() => {
    if (!isSupabaseAdmin) return
    let cancelled = false
    Promise.all([
      repo.fetchLegalUpdates(),
      repo.fetchReviews(),
      repo.fetchRules(),
      repo.fetchAlerts(),
      repo.fetchAuditLog(actorNameForId),
    ]).then(([lu, rv, ru, al, au]) => {
      if (cancelled) return
      setLegalUpdates(lu)
      setReviews(rv.map(review => repo.enrichReview(review, lu)))
      setRules(ru)
      setStoredAlerts(al)
      setAuditLog(au)
      setInitialLoading(false)
    }).catch(err => {
      if (cancelled) return
      setLoadError(err instanceof Error ? err.message : 'Failed to load Compliance Watchtower data from Supabase.')
      setInitialLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupabaseAdmin])

  // Separate, independent effect — deliberately not folded into the
  // Promise.all above, so the existing five-dataset load path is untouched.
  useEffect(() => {
    if (!isSupabaseAdmin) return
    let cancelled = false
    sourceRegistry.listRegulatorySources().then(async list => {
      if (cancelled) return
      const missing = listMissingStarterSources(list)
      if (missing.length === 0 || starterSeedAttemptedRef.current) {
        setSources(list)
        return
      }

      starterSeedAttemptedRef.current = true
      for (const source of missing) {
        await sourceRegistry.createRegulatorySource(source)
      }
      if (cancelled) return
      const updated = await sourceRegistry.listRegulatorySources()
      if (cancelled) return
      setSources(updated)
      setActionMessage({ type: 'success', text: `Linked ${missing.length} starter source${missing.length === 1 ? '' : 's'} automatically.` })
    }).catch(err => {
      if (cancelled) return
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load regulatory sources.' })
    })
    return () => { cancelled = true }
  }, [isSupabaseAdmin])

  const autoAlerts = useMemo(() => deriveRuleBasedComplianceAlerts(farms, inventory, rules), [farms, inventory, rules])
  const alerts = useMemo(() => mergeComplianceAlerts(autoAlerts, storedAlerts), [autoAlerts, storedAlerts])
  const readiness = useMemo(() => deriveExportReadiness(farms, inventory, alerts), [farms, inventory, alerts])

  const pendingReviews = reviews.filter(review => review.status === 'pending' || review.status === 'in_review')
  const activeRuleCount = rules.filter(isRuleEnforced).length
  const blockingAlertCount = alerts.filter(alert => alert.status === 'blocked').length

  // entryActorType defaults to 'admin' so every existing call site (all of
  // which pass only `entry`) is unchanged. A future AI-originated intake
  // path would pass 'ai_assistant' explicitly here — no such path exists
  // yet in this file.
  async function logAudit(
    entry: Omit<ComplianceAuditLog, 'id' | 'actorType' | 'actorId' | 'actorName' | 'createdAt'>,
    entryActorType: ComplianceAuditLog['actorType'] = 'admin',
  ): Promise<void> {
    if (isSupabaseAdmin && currentUser) {
      const row = await repo.insertAuditLog(entry, currentUser.id, actorNameForId, entryActorType)
      setAuditLog(prev => [row, ...prev])
      return
    }
    const next: ComplianceAuditLog[] = [{
      id: makeId('audit'),
      actorType: entryActorType,
      actorId,
      actorName,
      createdAt: new Date().toISOString(),
      ...entry,
    }, ...auditLog]
    setAuditLog(next)
    saveStored(STORAGE.audit, next)
  }

  function persistLegalUpdatesLocal(next: LegalUpdate[]): void {
    setLegalUpdates(next)
    saveStored(STORAGE.legalUpdates, next)
  }

  function persistReviewsLocal(next: ComplianceReview[]): void {
    setReviews(next)
    saveStored(STORAGE.reviews, next)
  }

  function persistRulesLocal(next: ComplianceRule[]): void {
    setRules(next)
    saveStored(STORAGE.rules, next)
  }

  function persistAlertsLocal(next: ComplianceAlert[]): void {
    setStoredAlerts(next)
    saveStored(STORAGE.alerts, next)
  }

  function persistSourcesLocal(next: RegulatorySource[]): void {
    setSources(next)
    saveStored(STORAGE.sources, next)
  }

  // ─── Phase 2H — manual AI draft summary (transient, human-review only) ──────
  //
  // Runs ONLY from an explicit "Generate AI Draft Summary" click — never on
  // mount, in an effect, on selection, after a feed check, or on any timer. The
  // guard + orchestration live in complianceAiSummarisation.ts / watchtowerAiSummary.ts
  // and are reused here (no guard logic is duplicated in this component). No
  // vendor SDK, fetch, or credential is used; the provider is injected and is
  // null in this build. The result is a transient draft — it is never written to
  // legalUpdate.summary, never persisted, and never approves/certifies/creates a
  // rule/enforces anything. A separate "Use as Draft Summary" persistence action
  // is intentionally NOT implemented: no safe repository summary-writer exists
  // (only updateLegalUpdateStatus), so acceptance would require a new persistence
  // path, which is out of Phase 2H scope.
  async function handleGenerateAiDraftSummary(update: LegalUpdate): Promise<void> {
    if (aiDraftBusy) return // duplicate-click / concurrency guard
    const eligibility = evaluateAiSummaryEligibility(update, {
      provider: AI_SUMMARY_PROVIDER,
      requestInProgress: aiDraftBusy,
    })
    if (!eligibility.canGenerate) {
      setAiDraftMessage({ type: 'error', text: eligibility.reason })
      return
    }
    setAiDraftBusy(true)
    setAiGeneratingUpdateId(update.id)
    setAiDraftMessage(null)
    setAiDraft(null) // clear any prior draft while a new one is generated
    aiRequestUpdateIdRef.current = update.id
    try {
      const outcome = await runAiDraftSummary(update, AI_SUMMARY_PROVIDER, {
        requestInProgress: false,
        isStillSelected: (id) => aiRequestUpdateIdRef.current === id,
      })
      if (outcome.ok) {
        setAiDraft(outcome.draft)
        setAiDraftMessage(null)
      } else {
        setAiDraft(null)
        setAiDraftMessage({ type: 'error', text: outcome.message })
      }
    } finally {
      setAiDraftBusy(false)
      setAiGeneratingUpdateId(null)
    }
  }

  function handleDiscardAiDraft(): void {
    aiRequestUpdateIdRef.current = null
    setAiDraft(null)
    setAiDraftMessage(null)
  }

  function resetSourceForm(): void {
    setSourceForm({
      name: '', jurisdiction: '', sourceType: SUPPORTED_SOURCE_TYPES[0], url: '',
      tier: 3, authorityType: 'aggregator', category: 'general', monitoringMethod: 'manual', priority: 100,
    })
    setEditingSourceId(null)
  }

  function startEditSource(source: RegulatorySource): void {
    setEditingSourceId(source.id)
    setSourceForm({
      name: source.name,
      jurisdiction: source.jurisdiction,
      sourceType: source.sourceType,
      url: source.url,
      // Fall back to the conservative Tier-3 signal shape for a pre-governance row.
      tier: source.tier ?? 3,
      authorityType: source.authorityType ?? 'aggregator',
      category: source.category ?? 'general',
      monitoringMethod: source.monitoringMethod ?? 'manual',
      priority: source.priority ?? 100,
    })
    setActionMessage(null)
  }

  // Validation (including duplicate-URL detection) always runs before any
  // write, in both Supabase and local/demo mode — via
  // complianceSourceRegistry.ts's createRegulatorySource/
  // updateRegulatorySource in Supabase mode, and via the same module's pure
  // decideRegulatorySourceWrite() in local/demo mode. A rejected decision
  // never reaches a repository call or a local state write.
  //
  // Note: unlike every other write path in this file, this one does not
  // call logAudit() — compliance_audit_log's `action` column has a fixed
  // SQL CHECK constraint with no regulatory-source-related value, and no
  // migration is in scope for this phase. Documented gap, not a silent
  // omission — a future migration could add source_created/source_updated/
  // source_deactivated action values.
  async function submitRegulatorySource(): Promise<void> {
    setActionMessage(null)
    const isEditing = !!editingSourceId

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const governance = {
          tier: sourceForm.tier,
          authorityType: sourceForm.authorityType,
          category: sourceForm.category,
          monitoringMethod: sourceForm.monitoringMethod,
          priority: sourceForm.priority,
        }
        const saved = isEditing
          ? await sourceRegistry.updateRegulatorySource(editingSourceId as string, {
              name: sourceForm.name,
              jurisdiction: sourceForm.jurisdiction,
              sourceType: sourceForm.sourceType,
              url: sourceForm.url,
              ...governance,
            })
          : await sourceRegistry.createRegulatorySource({
              name: sourceForm.name,
              jurisdiction: sourceForm.jurisdiction,
              sourceType: sourceForm.sourceType,
              url: sourceForm.url,
              ...governance,
            })
        setSources(prev => (isEditing ? prev.map(s => (s.id === saved.id ? saved : s)) : [saved, ...prev]))
        setActionMessage({ type: 'success', text: `Regulatory source ${isEditing ? 'updated' : 'added'}.` })
        resetSourceForm()
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save regulatory source.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const now = new Date().toISOString()
    const current = isEditing ? sources.find(s => s.id === editingSourceId) : undefined
    const candidate = {
      name: sourceForm.name.trim(),
      jurisdiction: sourceForm.jurisdiction.trim(),
      sourceType: sourceForm.sourceType,
      url: sourceForm.url.trim(),
      isActive: current?.isActive ?? true,
    }
    const decision = sourceRegistry.decideRegulatorySourceWrite(candidate, sources, editingSourceId ?? undefined)
    if (decision.action === 'reject') {
      setActionMessage({ type: 'error', text: decision.errors.join('; ') })
      return
    }
    if (isEditing && current) {
      persistSourcesLocal(sources.map(s => (s.id === editingSourceId ? {
        ...s,
        ...candidate,
        tier: sourceForm.tier,
        authorityType: sourceForm.authorityType,
        category: sourceForm.category,
        monitoringMethod: sourceForm.monitoringMethod,
        priority: sourceForm.priority,
        updatedAt: now,
      } : s)))
    } else {
      const created: RegulatorySource = {
        id: makeId('source'),
        ...candidate,
        lastCheckedAt: null,
        tier: sourceForm.tier,
        authorityType: sourceForm.authorityType,
        category: sourceForm.category,
        monitoringMethod: sourceForm.monitoringMethod,
        priority: sourceForm.priority,
        createdAt: now,
        updatedAt: now,
      }
      persistSourcesLocal([created, ...sources])
    }
    setActionMessage({ type: 'success', text: `Regulatory source ${isEditing ? 'updated' : 'added'} (local/demo mode).` })
    resetSourceForm()
  }

  async function seedStarterSources(): Promise<void> {
    setActionMessage(null)
    const missing = listMissingStarterSources(sources)
    if (missing.length === 0) {
      setActionMessage({ type: 'success', text: 'Starter sources already linked.' })
      return
    }

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin) {
        setActionMessage({ type: 'error', text: 'Admin access required to seed regulatory sources.' })
        return
      }
      setBusy(true)
      try {
        for (const source of missing) {
          await sourceRegistry.createRegulatorySource(source)
        }
        setSources(await sourceRegistry.listRegulatorySources())
        setActionMessage({ type: 'success', text: `Linked ${missing.length} starter source${missing.length === 1 ? '' : 's'}.` })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to seed starter sources.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const now = new Date().toISOString()
    const seeded: RegulatorySource[] = missing.map((source, index) => ({
      id: makeId(`source-seed-${index}`),
      name: source.name,
      jurisdiction: source.jurisdiction,
      sourceType: source.sourceType,
      url: source.url,
      isActive: source.isActive ?? true,
      lastCheckedAt: null,
      tier: source.tier,
      authorityType: source.authorityType,
      category: source.category,
      monitoringMethod: source.monitoringMethod,
      priority: source.priority,
      createdAt: now,
      updatedAt: now,
    }))
    persistSourcesLocal([...seeded, ...sources])
    setActionMessage({ type: 'success', text: `Linked ${seeded.length} starter source${seeded.length === 1 ? '' : 's'} (local/demo mode).` })
  }

  async function deactivateSource(source: RegulatorySource): Promise<void> {
    setActionMessage(null)
    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const updated = await sourceRegistry.deactivateRegulatorySource(source.id)
        setSources(prev => prev.map(s => (s.id === updated.id ? updated : s)))
        setActionMessage({ type: 'success', text: 'Regulatory source deactivated.' })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to deactivate regulatory source.' })
      } finally {
        setBusy(false)
      }
      return
    }
    persistSourcesLocal(sources.map(s => (s.id === source.id ? { ...s, isActive: false, updatedAt: new Date().toISOString() } : s)))
    setActionMessage({ type: 'success', text: 'Regulatory source deactivated (local/demo mode).' })
  }

  function handleAffectedAreaToggle(area: LegalUpdateAffectedArea, checked: boolean): void {
    setLegalForm(prev => ({
      ...prev,
      affectedAreas: checked ? [...prev.affectedAreas, area] : prev.affectedAreas.filter(item => item !== area),
    }))
  }

  async function submitLegalUpdate(): Promise<void> {
    if (!legalForm.title.trim()) return
    setActionMessage(null)

    // Runs before any Supabase write, local write, or audit-log entry below
    // — an unsafe finding here means no legal_update, compliance_review,
    // compliance_rule, alert, or audit_log entry is ever created for this
    // submission. This is an intake-safety check only; it does not change
    // rule-enforcement or human-approval behaviour anywhere else in this
    // file.
    const draftGuard = guardAiDraftedFields({
      title: legalForm.title,
      source: legalForm.sourceName,
      rawText: legalForm.rawText,
      summary: legalForm.summary,
    })
    if (!draftGuard.isSafe) {
      setActionMessage({
        type: 'error',
        text: 'Draft wording may imply unreviewed certification or compliance. Reword before review intake.',
      })
      return
    }

    // Manual Legal Update intake gate (Cannamonitor). A Cannamonitor-attributed
    // source is denied BEFORE any write — Supabase insert, local persistence,
    // review, or audit log — so arbitrary Cannamonitor raw evidence can never be
    // persisted through this form, and the form is not cleared as if it saved.
    // Unrelated sources are unaffected.
    const intakeGate = evaluateCannamonitorManualIntakeGate(legalForm.sourceUrl)
    if (intakeGate.action === 'deny') {
      setActionMessage({ type: 'error', text: intakeGate.reason })
      return
    }

    const now = new Date().toISOString()
    const riskLevel = riskFromAreas(legalForm.affectedAreas)

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin || !currentUser) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const update = await repo.insertLegalUpdate({
          sourceId: null,
          title: legalForm.title.trim(),
          jurisdiction: legalForm.jurisdiction.trim(),
          sourceName: legalForm.sourceName.trim(),
          sourceUrl: legalForm.sourceUrl.trim(),
          publishedAt: legalForm.publishedAt || null,
          rawText: legalForm.rawText.trim(),
          summary: legalForm.summary.trim(),
          affectedAreas: legalForm.affectedAreas,
          aiRiskLevel: riskLevel,
          status: 'new',
          reviewerNotes: legalForm.notes.trim(),
        })
        const review = await repo.insertReview({
          legalUpdateId: update.id,
          title: update.title,
          reviewType: 'legal_update',
          status: 'pending',
          reviewerNotes: '',
        })
        const nextLegalUpdates = [update, ...legalUpdates]
        setLegalUpdates(nextLegalUpdates)
        setReviews([repo.enrichReview(review, nextLegalUpdates), ...reviews])
        await logAudit({
          action: 'legal_update_created',
          entityType: 'legal_update',
          entityId: update.id,
          beforeState: null,
          afterState: update,
          reason: 'Manual regulatory/legal update intake created by admin.',
        })
        setActionMessage({ type: 'success', text: 'Legal update and review item saved to Supabase.' })
        setLegalForm({ title: '', jurisdiction: '', sourceName: '', sourceUrl: '', publishedAt: '', rawText: '', summary: '', affectedAreas: [], notes: '' })
        setTab('queue')
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save legal update to Supabase.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const update: LegalUpdate = {
      id: makeId('legal'),
      sourceId: null,
      title: legalForm.title.trim(),
      jurisdiction: legalForm.jurisdiction.trim(),
      sourceName: legalForm.sourceName.trim(),
      sourceUrl: legalForm.sourceUrl.trim(),
      publishedAt: legalForm.publishedAt || null,
      detectedAt: now,
      rawText: legalForm.rawText.trim(),
      summary: legalForm.summary.trim(),
      affectedAreas: legalForm.affectedAreas,
      aiRiskLevel: riskLevel,
      status: 'new',
      reviewerNotes: legalForm.notes.trim(),
      createdAt: now,
      updatedAt: now,
    }

    const review: ComplianceReview = {
      id: makeId('review'),
      legalUpdateId: update.id,
      alertId: null,
      ruleId: null,
      title: update.title,
      reviewType: 'legal_update',
      status: 'pending',
      riskLevel,
      affectedEntities: update.affectedAreas,
      summary: update.summary || update.rawText.slice(0, 280),
      recommendedAction: riskLevel === 'high' || riskLevel === 'critical' ? 'Review before operational status changes.' : 'Classify and monitor.',
      reviewerNotes: update.reviewerNotes,
      decision: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    persistLegalUpdatesLocal([update, ...legalUpdates])
    persistReviewsLocal([review, ...reviews])
    await logAudit({
      action: 'legal_update_created',
      entityType: 'legal_update',
      entityId: update.id,
      beforeState: null,
      afterState: update,
      reason: 'Manual regulatory/legal update intake created by admin.',
    })
    setActionMessage({ type: 'success', text: 'Legal update and review item saved (local/demo mode).' })
    setLegalForm({ title: '', jurisdiction: '', sourceName: '', sourceUrl: '', publishedAt: '', rawText: '', summary: '', affectedAreas: [], notes: '' })
    setTab('queue')
  }

  // Pure decision only — never fetches anything, never calls Supabase, never
  // calls an AI provider, and never writes a legal_update by itself. Persists
  // only the resulting snapshot (checksum + retrieved timestamp) so a repeat
  // check against the same source can tell unchanged from changed.
  async function runMonitoringCheck(): Promise<void> {
    setActionMessage(null)
    const source = sources.find(s => s.id === monitoringSourceId)
    const sourceKey = source?.id ?? monitoringSourceId.trim()
    const previousSnapshot = monitoringSnapshots[sourceKey] ?? null
    // Deliberately excludes sourceKey's own history — that comparison is
    // previousSnapshot's job (unchanged vs changed). knownChecksums here is
    // strictly for catching the same content mirrored under a *different*
    // registered source.
    const knownChecksums = Object.entries(monitoringSnapshots)
      .filter(([id]) => id !== sourceKey)
      .map(([, snapshot]) => snapshot.checksum)

    // Authoritative pasted-monitoring source-policy gate. A selected Cannamonitor
    // source is denied HERE — before any content is normalized, hashed, or turned
    // into a monitoring decision — so pasted Cannamonitor body text cannot enter
    // a checksum, `rawText`, a monitoring decision, a draft intake, or
    // persistence. Non-Cannamonitor sources are unaffected (identical behaviour).
    const result = await runPastedMonitoringDecision(source, sourceKey, monitoringContent, previousSnapshot, knownChecksums)
    if (!result.ok) {
      setMonitoringDecision(null)
      setActionMessage({ type: 'error', text: result.reason })
      return
    }
    const decision = result.decision
    setMonitoringDecision(decision)

    if (decision.snapshot) {
      const nextSnapshots = { ...monitoringSnapshots, [sourceKey]: decision.snapshot }
      setMonitoringSnapshots(nextSnapshots)
      saveStored(STORAGE.monitoringSnapshots, nextSnapshots)
    }
  }

  // Manual RSS/Atom feed check (Phase 2D). Runs ONLY when an operator clicks
  // "Check feed" for a specific source. It performs a read-only HTTPS GET
  // through the connector's injected fetch, displays the resulting monitoring
  // decisions for human review, and creates/approves/enforces nothing. The
  // canStartManualRun guard blocks concurrent runs from repeated clicks.
  async function handleCheckSourceFeed(source: RegulatorySource): Promise<void> {
    if (!canStartManualRun(rssCheckBusy)) return
    setActionMessage(null)
    setRssCheckSourceId(source.id)
    setRssCheckResult(null)
    setRssCheckBusy(true)

    // Compare against the source's SAVED technical baseline (if any). Reading a
    // corrupt store never throws to the user — it degrades to "no baseline"
    // (first-seen) with a note. This read does not modify or save anything.
    let baseline: MonitoringBaseline | null = null
    try {
      baseline = monitoringSnapshotRepo.getCurrentBaseline(source.id)
      setRssBaselineHistory(monitoringSnapshotRepo.listBaselineHistory(source.id))
    } catch {
      setRssBaselineHistory([])
      setActionMessage({ type: 'error', text: 'A saved baseline could not be read; comparing all items as first-seen.' })
    }
    setRssComparedBaseline(baseline)

    try {
      const result = await runManualRssMonitoring(source, createBrowserRssFetch(), {
        previousSnapshots: baselineToPreviousSnapshots(baseline),
      })
      setRssCheckResult(result)
    } finally {
      setRssCheckBusy(false)
    }
  }

  // Explicit, human-initiated save of the current feed check as a technical
  // baseline. A feed check NEVER saves automatically — only this handler writes,
  // and only via the narrow snapshot repository. It creates no legal update, no
  // rule, and marks nothing reviewed/approved. The decideBaselineSave gate
  // rejects stale/mismatched/unsuccessful/empty results and concurrent saves.
  async function handleSaveBaseline(): Promise<void> {
    const source = sources.find(s => s.id === rssCheckSourceId)
    const decision = decideBaselineSave(rssCheckResult, source?.id ?? null, rssSaveBusy)
    if (decision.action === 'reject') {
      setActionMessage({ type: 'error', text: decision.reason })
      return
    }
    setActionMessage(null)
    setRssSaveBusy(true)
    try {
      const history = monitoringSnapshotRepo.listBaselineHistory(source!.id)
      const candidate = buildBaselineCandidate(
        source!,
        rssCheckResult!,
        crypto.randomUUID(),
        new Date().toISOString(),
        nextBaselineVersion(history),
      )
      monitoringSnapshotRepo.saveBaseline(candidate)
      setRssComparedBaseline(candidate)
      setRssBaselineHistory(monitoringSnapshotRepo.listBaselineHistory(source!.id))
      setActionMessage({ type: 'success', text: `Technical baseline v${candidate.baselineVersion} saved for this source (checksums only).` })
    } catch {
      setActionMessage({ type: 'error', text: 'Could not save the technical baseline (local storage error). Nothing was changed.' })
    } finally {
      setRssSaveBusy(false)
    }
  }

  // The ONLY function in this file that may turn a monitoring decision into
  // a legal_update — reachable only from the "Create Legal Update from
  // Monitoring Decision" button, and only when the current decision is
  // changed_pending_review. Reuses the exact same repo.insertLegalUpdate /
  // repo.insertReview (Supabase) and persistLegalUpdatesLocal /
  // persistReviewsLocal (local/demo) calls that submitLegalUpdate() above
  // uses — this is not a second, parallel write path. The created
  // legal_update always has status 'new' and a pending review item; nothing
  // here ever touches compliance_rules or compliance_alerts, and nothing
  // here approves or activates anything.
  // Shared creation core (Phase 2F): turns ONE monitoring decision into a DRAFT
  // legal_update (status 'new') plus a pending review, through the existing
  // repository + audit path — no duplicated repository/audit logic. `source` is
  // the REGISTERED regulatory source the draft should reference, passed
  // explicitly (an RSS decision keys on a per-item id, not a source id). It
  // never summarises, analyses, calls AI, creates/approves a rule, or enforces —
  // summary stays empty and the only status ever written is 'new'.
  async function createDraftLegalUpdateFromDecision(
    decision: MonitoringDecision,
    source: RegulatorySource | undefined,
    setBusy: (busy: boolean) => void,
    onCreated: () => void,
  ): Promise<void> {
    // Pure branch logic (title/source derivation + the wording-safety gate) is
    // prepareMonitoringLegalUpdateIntake. 'skip' = not changed_pending_review;
    // 'blocked' = wording guard tripped — either way nothing is created.
    const prep = prepareMonitoringLegalUpdateIntake(decision, source, guardAiDraftedFields)
    if (prep.outcome === 'skip') return
    if (prep.outcome === 'blocked') {
      setActionMessage({ type: 'error', text: prep.reason })
      return
    }

    const { title, sourceId: preparedSourceId, sourceName, sourceUrl, jurisdiction, rawText, reviewerNotes } = prep.intake
    const now = new Date().toISOString()

    setBusy(true)
    try {
      if (repo.isSupabaseConfigured) {
        if (!isSupabaseAdmin || !currentUser) {
          setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
          return
        }
        const update = await repo.insertLegalUpdate({
          sourceId: preparedSourceId, title, jurisdiction, sourceName, sourceUrl,
          publishedAt: null, rawText, summary: '', affectedAreas: [], aiRiskLevel: 'info',
          status: 'new', reviewerNotes,
        })
        const review = await repo.insertReview({
          legalUpdateId: update.id, title: update.title, reviewType: 'legal_update',
          status: 'pending', reviewerNotes: '',
        })
        const nextLegalUpdates = [update, ...legalUpdates]
        setLegalUpdates(nextLegalUpdates)
        setReviews([repo.enrichReview(review, nextLegalUpdates), ...reviews])
        // actorType 'system' — a monitoring-decision intake, not a human-typed
        // one; the existing actor_type CHECK + action union already support this
        // without any migration.
        await logAudit({
          action: 'legal_update_created', entityType: 'legal_update', entityId: update.id,
          beforeState: null, afterState: update,
          reason: 'Draft legal update created from a monitoring decision (changed_pending_review). Pending human review.',
        }, 'system')
        setActionMessage({ type: 'success', text: 'Draft legal update created and saved to Supabase. Pending human review.' })
        onCreated()
        return
      }

      const update: LegalUpdate = {
        id: makeId('legal'), sourceId: preparedSourceId, title, jurisdiction, sourceName, sourceUrl,
        publishedAt: null, detectedAt: now, rawText, summary: '', affectedAreas: [], aiRiskLevel: 'info',
        status: 'new', reviewerNotes, createdAt: now, updatedAt: now,
      }
      const review: ComplianceReview = {
        id: makeId('review'), legalUpdateId: update.id, alertId: null, ruleId: null,
        title: update.title, reviewType: 'legal_update', status: 'pending', riskLevel: 'info',
        affectedEntities: [], summary: update.rawText.slice(0, 280), recommendedAction: 'Classify and monitor.',
        reviewerNotes: update.reviewerNotes, decision: null, reviewedBy: null, reviewedAt: null,
        createdAt: now, updatedAt: now,
      }
      persistLegalUpdatesLocal([update, ...legalUpdates])
      persistReviewsLocal([review, ...reviews])
      await logAudit({
        action: 'legal_update_created', entityType: 'legal_update', entityId: update.id,
        beforeState: null, afterState: update,
        reason: 'Draft legal update created from a monitoring decision (changed_pending_review). Pending human review.',
      }, 'system')
      setActionMessage({ type: 'success', text: 'Draft legal update created (local/demo mode). Pending human review.' })
      onCreated()
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to create the draft legal update.' })
    } finally {
      setBusy(false)
    }
  }

  // Paste-flow handler: reuses the shared core (behaviour preserved).
  async function createLegalUpdateFromMonitoringDecision(): Promise<void> {
    if (!monitoringDecision) return
    setActionMessage(null)
    const source = monitoringDecision.proposedLegalUpdate
      ? sources.find(s => s.id === monitoringDecision.proposedLegalUpdate!.sourceId)
      : undefined
    await createDraftLegalUpdateFromDecision(monitoringDecision, source, setMonitoringBusy, () => {
      setMonitoringDecision(null)
      setMonitoringContent('')
      setTab('queue')
    })
  }

  // Manual RSS-item handler (Phase 2F): creates a draft legal update from ONE
  // feed item's monitoring decision, ONLY on an explicit click. The
  // decideDraftCreation gate allows only changed_pending_review, blocks a
  // concurrent creation, and blocks a repeat for an already-drafted item. The
  // registered source is passed explicitly.
  async function handleCreateDraftFromRssItem(decision: MonitoringDecision): Promise<void> {
    const gate = decideDraftCreation(decision, rssDraftBusy, rssDraftedItemIds.has(decision.sourceId))
    if (gate.action === 'reject') {
      setActionMessage({ type: 'error', text: gate.reason })
      return
    }
    setActionMessage(null)
    const source = sources.find(s => s.id === rssCheckSourceId)
    await createDraftLegalUpdateFromDecision(decision, source, setRssDraftBusy, () => {
      setRssDraftedItemIds(prev => { const next = new Set(prev); next.add(decision.sourceId); return next })
    })
  }

  async function updateReviewDecision(review: ComplianceReview, decision: string): Promise<void> {
    setActionMessage(null)
    const now = new Date().toISOString()
    const relatedUpdate = review.legalUpdateId ? legalUpdates.find(update => update.id === review.legalUpdateId) : undefined

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin || !currentUser) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const nextStatus: ComplianceReview['status'] = decision === 'send_to_legal' ? 'sent_to_legal' : decision === 'reject' ? 'rejected' : decision === 'archive' ? 'archived' : 'reviewed'
        const updatedReview = await repo.updateReview(review.id, {
          status: nextStatus,
          decision,
          reviewedBy: currentUser.id,
        })

        let nextLegalUpdates = legalUpdates
        if (relatedUpdate) {
          const updateStatus: LegalUpdate['status'] = decision === 'send_to_legal'
            ? 'sent_to_legal'
            : decision === 'reject'
              ? 'rejected'
              : decision === 'archive'
                ? 'archived'
                : decision === 'create_rule'
                  ? 'rule_suggested'
                  : 'reviewed'
          const updatedLegalUpdate = await repo.updateLegalUpdateStatus(relatedUpdate.id, updateStatus)
          nextLegalUpdates = legalUpdates.map(update => update.id === updatedLegalUpdate.id ? updatedLegalUpdate : update)
        }

        let nextRules = rules
        let action: ComplianceAuditLog['action'] = 'legal_update_reviewed'
        let afterState: unknown = updatedReview

        if ((decision === 'create_rule' || decision === 'approve_rule') && relatedUpdate) {
          const severity = relatedUpdate.aiRiskLevel ?? review.riskLevel
          const newRule = await repo.insertRule({
            ruleCode: `LEGAL_${relatedUpdate.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`,
            title: `Review requirement: ${relatedUpdate.title}`,
            description: relatedUpdate.summary || 'Human-created rule from legal update. Refine before operational use.',
            jurisdiction: relatedUpdate.jurisdiction || null,
            entityType: entityTypeFromAreas(relatedUpdate.affectedAreas),
            severity,
            isBlocking: severity === 'high' || severity === 'critical',
            status: decision === 'approve_rule' ? 'active' : 'suggested',
            sourceLegalUpdateId: relatedUpdate.id,
            approvedBy: decision === 'approve_rule' ? currentUser.id : null,
            approvedAt: decision === 'approve_rule' ? now : null,
          })
          nextRules = [newRule, ...rules]
          action = decision === 'approve_rule' ? 'rule_approved' : 'rule_suggested'
          afterState = { review: updatedReview, rule: newRule }
        }

        if (decision === 'send_to_legal') action = 'sent_to_legal_review'
        if (decision === 'archive') action = 'legal_update_archived'

        setReviews(reviews.map(item => item.id === review.id ? repo.enrichReview(updatedReview, nextLegalUpdates) : item))
        setLegalUpdates(nextLegalUpdates)
        setRules(nextRules)
        await logAudit({
          action,
          entityType: 'compliance_review',
          entityId: review.id,
          beforeState: review,
          afterState,
          reason: `Review decision: ${statusText(decision)}`,
        })
        setActionMessage({ type: 'success', text: 'Review decision saved to Supabase.' })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update review.' })
      } finally {
        setBusy(false)
      }
      return
    }

    let nextLegalUpdates = legalUpdates
    let nextRules = rules
    let action: ComplianceAuditLog['action'] = 'legal_update_reviewed'
    let afterState: unknown = review

    const nextReview: ComplianceReview = {
      ...review,
      status: decision === 'send_to_legal' ? 'sent_to_legal' : decision === 'reject' ? 'rejected' : decision === 'archive' ? 'archived' : 'reviewed',
      decision,
      reviewedBy: actorName,
      reviewedAt: now,
      updatedAt: now,
    }

    if (relatedUpdate) {
      const updateStatus: LegalUpdate['status'] = decision === 'send_to_legal'
        ? 'sent_to_legal'
        : decision === 'reject'
          ? 'rejected'
          : decision === 'archive'
            ? 'archived'
            : decision === 'create_rule'
              ? 'rule_suggested'
              : 'reviewed'
      const updatedLegalUpdate: LegalUpdate = { ...relatedUpdate, status: updateStatus, updatedAt: now }
      nextLegalUpdates = legalUpdates.map(update => update.id === updatedLegalUpdate.id ? updatedLegalUpdate : update)
      afterState = { review: nextReview, legalUpdate: updatedLegalUpdate }
    }

    if ((decision === 'create_rule' || decision === 'approve_rule') && relatedUpdate) {
      const newRule: ComplianceRule = {
        id: makeId('rule'),
        ruleCode: `LEGAL_${relatedUpdate.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`,
        title: `Review requirement: ${relatedUpdate.title}`,
        description: relatedUpdate.summary || 'Human-created rule from legal update. Refine before operational use.',
        jurisdiction: relatedUpdate.jurisdiction || null,
        entityType: entityTypeFromAreas(relatedUpdate.affectedAreas),
        severity: relatedUpdate.aiRiskLevel ?? review.riskLevel,
        isBlocking: (relatedUpdate.aiRiskLevel ?? review.riskLevel) === 'high' || (relatedUpdate.aiRiskLevel ?? review.riskLevel) === 'critical',
        status: decision === 'approve_rule' ? 'active' : 'suggested',
        sourceLegalUpdateId: relatedUpdate.id,
        approvedBy: decision === 'approve_rule' ? actorName : null,
        approvedAt: decision === 'approve_rule' ? now : null,
        createdAt: now,
        updatedAt: now,
      }
      nextRules = [newRule, ...rules]
      action = decision === 'approve_rule' ? 'rule_approved' : 'rule_suggested'
      afterState = { review: nextReview, rule: newRule }
    }

    if (decision === 'send_to_legal') action = 'sent_to_legal_review'
    if (decision === 'archive') action = 'legal_update_archived'

    persistReviewsLocal(reviews.map(item => item.id === review.id ? nextReview : item))
    persistLegalUpdatesLocal(nextLegalUpdates)
    persistRulesLocal(nextRules)
    await logAudit({
      action,
      entityType: 'compliance_review',
      entityId: review.id,
      beforeState: review,
      afterState,
      reason: `Review decision: ${statusText(decision)}`,
    })
    setActionMessage({ type: 'success', text: 'Review decision saved (local/demo mode).' })
  }

  async function updateRuleStatus(rule: ComplianceRule, status: ComplianceRule['status']): Promise<void> {
    setActionMessage(null)
    const now = new Date().toISOString()

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin || !currentUser) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const updated = await repo.updateRuleStatus(rule.id, status, currentUser.id)
        setRules(rules.map(item => item.id === rule.id ? updated : item))
        const action: ComplianceAuditLog['action'] = status === 'paused'
          ? 'rule_paused'
          : status === 'retired'
            ? 'rule_retired'
            : status === 'rejected'
              ? 'rule_rejected'
              : 'rule_approved'
        await logAudit({
          action,
          entityType: 'compliance_rule',
          entityId: rule.id,
          beforeState: rule,
          afterState: updated,
          reason: `Rule status changed to ${statusText(status)}.`,
        })
        setActionMessage({ type: 'success', text: 'Rule status saved to Supabase.' })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update rule status.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const updated: ComplianceRule = {
      ...rule,
      status,
      approvedBy: isEnforcedRuleStatus(status) ? actorName : rule.approvedBy,
      approvedAt: isEnforcedRuleStatus(status) ? now : rule.approvedAt,
      updatedAt: now,
    }
    persistRulesLocal(rules.map(item => item.id === rule.id ? updated : item))
    const action: ComplianceAuditLog['action'] = status === 'paused'
      ? 'rule_paused'
      : status === 'retired'
        ? 'rule_retired'
        : status === 'rejected'
          ? 'rule_rejected'
          : 'rule_approved'
    await logAudit({
      action,
      entityType: 'compliance_rule',
      entityId: rule.id,
      beforeState: rule,
      afterState: updated,
      reason: `Rule status changed to ${statusText(status)}.`,
    })
    setActionMessage({ type: 'success', text: 'Rule status saved (local/demo mode).' })
  }

  async function submitManualAlert(): Promise<void> {
    if (!alertForm.alertTitle.trim()) return
    setActionMessage(null)
    const now = new Date().toISOString()
    const status: ComplianceStatus = alertForm.severity === 'critical' ? 'blocked' : 'open'
    // Re-validated against the current rules list at submit time (not just at
    // selection time) so a rule that was paused/retired/rejected between
    // opening the dropdown and clicking submit can never be linked.
    const linkedRule = rules.find(rule => rule.id === alertForm.linkedRuleId)
    const linkedRuleId = linkedRule && isRuleEnforced(linkedRule) ? linkedRule.id : null

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        const alert = await repo.insertAlert({
          entityType: alertForm.entityType,
          entityId: alertForm.entityId.trim() || 'manual-unlinked',
          ruleId: linkedRuleId,
          legalUpdateId: null,
          alertTitle: alertForm.alertTitle.trim(),
          alertDetail: alertForm.alertDetail.trim(),
          severity: alertForm.severity,
          status,
        })
        setStoredAlerts([alert, ...storedAlerts])
        await logAudit({
          action: 'alert_created',
          entityType: 'compliance_alert',
          entityId: alert.id,
          beforeState: null,
          afterState: alert,
          reason: 'Manual compliance alert created.',
        })
        setActionMessage({ type: 'success', text: 'Alert saved to Supabase.' })
        setAlertForm({ entityType: 'document', entityId: '', alertTitle: '', alertDetail: '', severity: 'medium', linkedRuleId: '' })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save alert.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const alert: ComplianceAlert = {
      id: makeId('alert'),
      entityType: alertForm.entityType,
      entityId: alertForm.entityId.trim() || 'manual-unlinked',
      ruleId: linkedRuleId,
      legalUpdateId: null,
      alertTitle: alertForm.alertTitle.trim(),
      alertDetail: alertForm.alertDetail.trim(),
      severity: alertForm.severity,
      status,
      createdAt: now,
      resolvedAt: null,
      resolutionNotes: null,
    }
    persistAlertsLocal([alert, ...storedAlerts])
    await logAudit({
      action: 'alert_created',
      entityType: 'compliance_alert',
      entityId: alert.id,
      beforeState: null,
      afterState: alert,
      reason: 'Manual compliance alert created.',
    })
    setActionMessage({ type: 'success', text: 'Alert saved (local/demo mode).' })
    setAlertForm({ entityType: 'document', entityId: '', alertTitle: '', alertDetail: '', severity: 'medium', linkedRuleId: '' })
  }

  async function updateAlertStatus(alert: ComplianceAlert, status: ComplianceStatus): Promise<void> {
    setActionMessage(null)
    const now = new Date().toISOString()
    const isAutoAlert = alert.id.startsWith('auto-')
    const resolutionNotes = status === 'resolved' ? 'Resolved by admin review.' : status === 'dismissed' ? 'Dismissed by admin review.' : alert.resolutionNotes ?? null

    if (repo.isSupabaseConfigured) {
      if (!isSupabaseAdmin) {
        setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
        return
      }
      setBusy(true)
      try {
        let updated: ComplianceAlert
        if (isAutoAlert) {
          updated = await repo.insertAlert({
            entityType: alert.entityType,
            entityId: alert.entityId,
            ruleId: alert.ruleId,
            legalUpdateId: alert.legalUpdateId,
            alertTitle: alert.alertTitle,
            alertDetail: alert.alertDetail,
            severity: alert.severity,
            status,
          })
          setStoredAlerts([updated, ...storedAlerts])
        } else {
          updated = await repo.updateAlertStatus(alert.id, status, resolutionNotes)
          setStoredAlerts(storedAlerts.map(item => item.id === alert.id ? updated : item))
        }
        await logAudit({
          action: status === 'resolved' ? 'alert_resolved' : status === 'dismissed' ? 'alert_dismissed' : 'reviewer_note_added',
          entityType: 'compliance_alert',
          entityId: updated.id,
          beforeState: alert,
          afterState: updated,
          reason: `Alert status changed to ${statusText(status)}.`,
        })
        setActionMessage({ type: 'success', text: 'Alert status saved to Supabase.' })
      } catch (err) {
        setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to update alert status.' })
      } finally {
        setBusy(false)
      }
      return
    }

    const updated: ComplianceAlert = {
      ...alert,
      status,
      resolvedAt: status === 'resolved' || status === 'dismissed' ? now : alert.resolvedAt,
      resolutionNotes: status === 'resolved' ? 'Resolved by admin review.' : status === 'dismissed' ? 'Dismissed by admin review.' : alert.resolutionNotes,
    }
    const existing = storedAlerts.some(item => item.id === alert.id)
    persistAlertsLocal(existing ? storedAlerts.map(item => item.id === alert.id ? updated : item) : [updated, ...storedAlerts])
    await logAudit({
      action: status === 'resolved' ? 'alert_resolved' : status === 'dismissed' ? 'alert_dismissed' : 'reviewer_note_added',
      entityType: 'compliance_alert',
      entityId: alert.id,
      beforeState: alert,
      afterState: updated,
      reason: `Alert status changed to ${statusText(status)}.`,
    })
    setActionMessage({ type: 'success', text: 'Alert status saved (local/demo mode).' })
  }

  async function saveReadinessSnapshot(entityStatus: import('../../types').ComplianceEntityStatus): Promise<void> {
    if (!isSupabaseAdmin) {
      setActionMessage({ type: 'error', text: 'Admin access required to save to Supabase.' })
      return
    }
    setActionMessage(null)
    setBusy(true)
    try {
      await repo.upsertEntityStatus(entityStatus)
      setActionMessage({ type: 'success', text: 'Export readiness snapshot saved to Supabase.' })
    } catch (err) {
      setActionMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save readiness snapshot.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-wrap ddp-wrap">
      <div className="page-header ddp-header">
        <div className="page-eyebrow ddp-eyebrow">DDP OPERATIONS — REGULATORY INTELLIGENCE</div>
        <h1 className="page-title">Compliance Watchtower</h1>
        <p className="page-desc">
          Regulatory Intelligence &amp; Export Readiness Engine for manual legal update intake, human review, approved rules, readiness checks, alerts, and audit history.
        </p>
      </div>

      <div className="disclaimer-box">
        <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>CONTROL</span>
        <div>
          Compliance Watchtower is a decision-support tool, not legal advice. AI-assisted summaries require human review.
          Export/import readiness depends on verified documents, current law, and qualified legal/compliance approval.
        </div>
      </div>

      {repo.isSupabaseConfigured ? (
        <div className="disclaimer-box" style={{ marginTop: 10 }}>
          <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>DATA</span>
          <div>
            {!isSupabaseAdmin
              ? 'Admin access required to load or save Compliance Watchtower data.'
              : initialLoading
                ? 'Loading Compliance Watchtower data from Supabase…'
                : loadError
                  ? `Supabase load error: ${loadError}`
                  : 'Connected to Supabase. Changes here are persisted for DDP admin use only.'}
          </div>
        </div>
      ) : (
        <div className="disclaimer-box" style={{ marginTop: 10 }}>
          <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>DATA</span>
          <div>Supabase is not configured in this environment. Running in local/demo mode — data is stored only in this browser and is not shared or persisted centrally.</div>
        </div>
      )}

      {actionMessage && (
        <div className="disclaimer-box" style={{ marginTop: 10, borderColor: actionMessage.type === 'error' ? 'var(--danger, #b3261e)' : undefined }}>
          <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: actionMessage.type === 'error' ? 'var(--danger, #b3261e)' : 'var(--success, #1b7f4d)' }}>
            {actionMessage.type === 'error' ? 'ERROR' : 'SAVED'}
          </span>
          <div>{actionMessage.text}</div>
        </div>
      )}

      <div className="summary-grid-8">
        <div className="summary-card s-total"><div className="summary-val">{legalUpdates.length}</div><div className="summary-lbl">Legal Updates</div></div>
        <div className="summary-card s-pending"><div className="summary-val">{pendingReviews.length}</div><div className="summary-lbl">Needs Review</div></div>
        <div className="summary-card s-approved"><div className="summary-val">{activeRuleCount}</div><div className="summary-lbl">Approved / Active Rules</div></div>
        <div className="summary-card s-missing"><div className="summary-val">{blockingAlertCount}</div><div className="summary-lbl">Blocking Alerts</div></div>
      </div>

      <div className="filter-tabs supply-ledger-tabs" style={{ marginTop: 22 }}>
        {TABS.map(item => (
          <button key={item.id} className={`filter-tab${tab === item.id ? ' filter-active' : ''}`} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'monitor' && (
        <div className="card" style={{ padding: 22, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Manual Legal / Regulatory Update Intake</h2>
          <p className="td-muted">Paste and classify a source manually. AI summary fields are treated as manual/stubbed until a backend AI integration exists.</p>
          <div className="form-grid-3">
            <label className="field">
              <span>Title</span>
              <input value={legalForm.title} onChange={e => setLegalForm({ ...legalForm, title: e.target.value })} />
            </label>
            <label className="field">
              <span>Jurisdiction</span>
              <input value={legalForm.jurisdiction} onChange={e => setLegalForm({ ...legalForm, jurisdiction: e.target.value })} />
            </label>
            <label className="field">
              <span>Source name</span>
              <input value={legalForm.sourceName} onChange={e => setLegalForm({ ...legalForm, sourceName: e.target.value })} />
            </label>
            <label className="field">
              <span>Source URL</span>
              <input value={legalForm.sourceUrl} onChange={e => setLegalForm({ ...legalForm, sourceUrl: e.target.value })} />
            </label>
            <label className="field">
              <span>Published date if known</span>
              <input type="date" value={legalForm.publishedAt} onChange={e => setLegalForm({ ...legalForm, publishedAt: e.target.value })} />
            </label>
          </div>
          <div style={{ marginTop: 18 }}>
            <div className="td-bold" style={{ marginBottom: 8 }}>Affected area</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {AFFECTED_AREA_OPTIONS.map(area => (
                <label key={area} className="status-pill status-claimed" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={legalForm.affectedAreas.includes(area)} onChange={e => handleAffectedAreaToggle(area, e.target.checked)} />
                  {area}
                </label>
              ))}
            </div>
          </div>
          <label className="field" style={{ marginTop: 18 }}>
            <span>Raw pasted text</span>
            <textarea rows={6} value={legalForm.rawText} onChange={e => setLegalForm({ ...legalForm, rawText: e.target.value })} />
          </label>
          <label className="field" style={{ marginTop: 14 }}>
            <span>AI-assisted/manual summary</span>
            <textarea rows={4} value={legalForm.summary} onChange={e => setLegalForm({ ...legalForm, summary: e.target.value })} />
          </label>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Reviewer notes</span>
            <textarea rows={3} value={legalForm.notes} onChange={e => setLegalForm({ ...legalForm, notes: e.target.value })} />
          </label>
          <button className="btn btn-primary" style={{ marginTop: 18 }} disabled={busy} onClick={() => { void submitLegalUpdate() }}>
            {busy ? 'Saving…' : 'Create Legal Update + Review Item'}
          </button>
        </div>
      )}

      {tab === 'monitoring-queue' && (
        <div className="card" style={{ padding: 22, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Monitoring Queue</h2>
          <p className="td-muted">
            Manual-only. Paste content you have retrieved yourself from a registered source below to check it
            against the last known snapshot for that source. This performs no network fetch, no scheduled check,
            and no AI summarisation — it only computes a checksum and compares it. A detected change proposes a
            pending legal update for human review; it never creates or approves a compliance rule.
          </p>
          <div className="form-grid-3">
            <label className="field">
              <span>Regulatory source</span>
              <select value={monitoringSourceId} onChange={e => { setMonitoringSourceId(e.target.value); setMonitoringDecision(null) }}>
                <option value="">Select a registered source…</option>
                {sources.map(source => (
                  <option key={source.id} value={source.id}>{source.name} ({source.jurisdiction})</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Pasted source content (as currently retrieved)</span>
            <textarea rows={8} value={monitoringContent} onChange={e => { setMonitoringContent(e.target.value); setMonitoringDecision(null) }} />
          </label>
          <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={monitoringBusy} onClick={() => { void runMonitoringCheck() }}>
            {monitoringBusy ? 'Checking…' : 'Run Monitoring Check'}
          </button>

          {monitoringDecision && (
            <div className="disclaimer-box" style={{ marginTop: 18 }}>
              <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>
                {statusText(monitoringDecision.kind)}
              </span>
              <div>{monitoringDecision.reason}</div>
            </div>
          )}

          {monitoringDecision?.kind === 'changed_pending_review' && monitoringDecision.proposedLegalUpdate && (
            <div style={{ marginTop: 18 }}>
              <div className="td-bold" style={{ marginBottom: 8 }}>Proposed legal update intake preview</div>
              <div className="detail-rows">
                <div className="detail-row">
                  <span className="dl">Source</span>
                  <span className="dv">{sources.find(s => s.id === monitoringDecision.sourceId)?.name || monitoringDecision.sourceId}</span>
                </div>
                <div className="detail-row"><span className="dl">Retrieved at</span><span className="dv">{monitoringDecision.proposedLegalUpdate.retrievedAt}</span></div>
                <div className="detail-row"><span className="dl">Checksum</span><span className="dv">{monitoringDecision.proposedLegalUpdate.checksum}</span></div>
                <div className="detail-row">
                  <span className="dl">Normalized content preview</span>
                  <span className="dv" style={{ whiteSpace: 'pre-wrap' }}>{monitoringDecision.proposedLegalUpdate.normalizedContent.slice(0, 600)}</span>
                </div>
                <div className="detail-row">
                  <span className="dl">Original pasted content</span>
                  <span className="dv" style={{ whiteSpace: 'pre-wrap' }}>{monitoringDecision.proposedLegalUpdate.rawContent.slice(0, 600)}</span>
                </div>
              </div>
              <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={monitoringBusy} onClick={() => { void createLegalUpdateFromMonitoringDecision() }}>
                {monitoringBusy ? 'Creating…' : 'Create Legal Update from Monitoring Decision'}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'queue' && (() => {
        // Transient AI draft is shown only while its update is still a 'new'
        // draft; if the update changed status or was removed, the stale draft is
        // not rendered (render-time invalidation, complementing the controller's
        // stale_selection check).
        const aiDraftUpdate = aiDraft ? legalUpdates.find(item => item.id === aiDraft.legalUpdateId && item.status === 'new') : undefined
        return (
        <>
        <div className="card table-card" style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--cards">
              <thead><tr><th>Risk</th><th>Title</th><th>Source / Jurisdiction</th><th>Summary</th><th>Recommended action</th><th>Status</th><th>Decision</th></tr></thead>
              <tbody>
                {reviews.map(review => {
                  const update = review.legalUpdateId ? legalUpdates.find(item => item.id === review.legalUpdateId) : undefined
                  const aiEligibility = update && update.status === 'new'
                    ? evaluateAiSummaryEligibility(update, { provider: AI_SUMMARY_PROVIDER, requestInProgress: aiDraftBusy })
                    : null
                  return (
                    <tr key={review.id}>
                      <td><span className={`badge ${SEVERITY_CLASS[review.riskLevel]}`}>{review.riskLevel.toUpperCase()}</span></td>
                      <td><span className="td-bold">{review.title}</span><br /><span className="td-muted">{review.affectedEntities.join(', ') || 'No affected area selected'}</span></td>
                      <td>{update?.sourceName || 'Manual'}<br /><span className="td-muted">{update?.jurisdiction || '—'}</span></td>
                      <td style={{ maxWidth: 280 }}>{review.summary || 'No summary supplied.'}</td>
                      <td style={{ maxWidth: 220 }}>{review.recommendedAction}</td>
                      <td><span className="status-pill status-reviewed">{statusText(review.status)}</span></td>
                      <td style={{ minWidth: 250 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'informational') }}>Mark informational</button>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'create_rule') }}>Create suggested rule</button>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'approve_rule') }}>Approve rule</button>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'send_to_legal') }}>Send to legal</button>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'reject') }}>Reject</button>
                          <button className="btn btn-review" disabled={busy} onClick={() => { void updateReviewDecision(review, 'archive') }}>Archive</button>
                          {update && aiEligibility && (
                            <button
                              className="btn btn-review"
                              disabled={busy || aiDraftBusy || !aiEligibility.canGenerate}
                              title={aiEligibility.canGenerate ? 'Draft only — requires human legal review' : aiEligibility.reason}
                              // aiRequestUpdateIdRef is an async stale-guard token, read only inside the
                              // event-handler-initiated async callback (never during render), so the
                              // late result of a discarded/superseded run is dropped, not shown.
                              // eslint-disable-next-line react-hooks/refs
                              onClick={() => { void handleGenerateAiDraftSummary(update) }}
                            >{aiGeneratingUpdateId === update.id ? 'Generating…' : 'Generate AI Draft Summary'}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {reviews.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28 }}>{initialLoading ? 'Loading review items…' : 'No review items yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {aiDraftMessage && (
          <div className={`card`} style={{ marginTop: 12, borderLeft: aiDraftMessage.type === 'error' ? '4px solid #c0392b' : '4px solid #2d7' }}>
            <p style={{ margin: 8 }}>{aiDraftMessage.text}</p>
          </div>
        )}

        {aiDraft && aiDraftUpdate && (
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <span className="badge" style={{ background: '#7a5', color: '#fff' }}>Draft only</span>{' '}
                <strong>AI-generated draft — requires human legal review</strong>
              </div>
              <button className="btn btn-review" disabled={aiDraftBusy} onClick={() => { handleDiscardAiDraft() }}>Discard draft</button>
            </div>
            <p className="td-muted" style={{ marginTop: 4 }}>
              For: <strong>{aiDraftUpdate.title}</strong>. This draft is transient — it is not saved, does not
              change this legal update, and is not a record of legal review, approval, or compliance status.
            </p>
            <div style={{ marginTop: 8 }}>
              <h4 style={{ margin: '8px 0 2px' }}>Draft factual summary</h4>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{aiDraft.draftSummary}</p>
              <h4 style={{ margin: '8px 0 2px' }}>Possible significance</h4>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{aiDraft.possibleSignificance}</p>
              <h4 style={{ margin: '8px 0 2px' }}>Uncertainties</h4>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{aiDraft.uncertainties}</p>
              <h4 style={{ margin: '8px 0 2px' }}>Questions for human legal review</h4>
              <ul style={{ margin: 0 }}>{aiDraft.reviewQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              <h4 style={{ margin: '8px 0 2px' }}>Source references</h4>
              {aiDraft.sourceReferences.length > 0
                ? <ul style={{ margin: 0 }}>{aiDraft.sourceReferences.map((r, i) => <li key={i}>{r}</li>)}</ul>
                : <p className="td-muted" style={{ margin: 0 }}>None. No reference could be matched to the recorded source evidence.</p>}
              <p className="td-muted" style={{ marginTop: 4, fontSize: 12 }}>
                Each reference above was matched against the recorded source name, URL, or raw evidence
                before display. References the AI produced that could not be matched are discarded, so this
                list is not a citation of the underlying legislation — the primary source text is not held here.
                {aiDraft.droppedSourceReferences > 0
                  ? ` ${aiDraft.droppedSourceReferences} unmatched reference(s) were discarded from this draft.`
                  : ''}
              </p>
            </div>
            <p className="td-muted" style={{ marginTop: 8, fontSize: 12 }}>
              Provider: {aiDraft.providerId} · Model: {aiDraft.modelId} · Generated: {aiDraft.generatedAt}
            </p>
          </div>
        )}
        </>
        )
      })()}

      {tab === 'rules' && (
        <div className="card table-card" style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--cards">
              <thead><tr><th>Rule</th><th>Entity</th><th>Severity</th><th>Blocking</th><th>Status</th><th>Approval</th><th>Actions</th></tr></thead>
              <tbody>
                {rules.map(rule => (
                  <tr key={rule.id}>
                    <td><span className="td-bold">{rule.ruleCode}</span><br />{rule.title}<br /><span className="td-muted">{rule.description}</span></td>
                    <td>{statusText(rule.entityType)}<br /><span className="td-muted">{rule.jurisdiction || 'No jurisdiction set'}</span></td>
                    <td><span className={`badge ${SEVERITY_CLASS[rule.severity]}`}>{rule.severity.toUpperCase()}</span></td>
                    <td>{rule.isBlocking ? <span className="status-pill status-reject">Blocking</span> : <span className="status-pill status-claimed">Non-blocking</span>}</td>
                    <td><span className="status-pill status-reviewed">{statusText(rule.status)}</span></td>
                    <td>{(rule.approvedBy ? actorNameForId(rule.approvedBy) : null) || '—'}<br /><span className="td-muted">{rule.approvedAt || 'Pending human approval'}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateRuleStatus(rule, 'active') }}>Approve / Activate</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateRuleStatus(rule, 'paused') }}>Pause</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateRuleStatus(rule, 'retired') }}>Retire</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateRuleStatus(rule, 'rejected') }}>Reject</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28 }}>{initialLoading ? 'Loading rules…' : 'No compliance rules yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'readiness' && (
        <div className="card table-card" style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--cards">
              <thead><tr><th>Batch</th><th>Farm</th><th>Readiness</th><th>Risk</th><th>Missing requirements</th><th></th></tr></thead>
              <tbody>
                {readiness.map(record => (
                  <tr key={record.id}>
                    <td><span className="td-bold">{record.item.productName || 'Unnamed batch'}</span><br /><span className="td-muted">Batch: {record.item.batchNumber || 'Missing'}</span></td>
                    <td>{record.farm?.tradingName || record.item.farmName || 'Unlinked farm'}</td>
                    <td><span className={`status-pill ${record.entityStatus.readinessStatus === 'blocked' ? 'status-reject' : 'status-reviewed'}`}>{statusText(record.entityStatus.readinessStatus)}</span></td>
                    <td><span className={`badge ${SEVERITY_CLASS[record.entityStatus.riskLevel]}`}>{record.entityStatus.riskLevel.toUpperCase()}</span></td>
                    <td style={{ maxWidth: 320 }}>{record.entityStatus.missingRequirements.slice(0, 4).join('; ')}{record.entityStatus.missingRequirements.length > 4 ? '…' : ''}</td>
                    <td style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button className="btn btn-review" onClick={() => setOpenReadinessId(openReadinessId === record.id ? null : record.id)}>{openReadinessId === record.id ? 'Close' : 'Open checklist'}</button>
                      {repo.isSupabaseConfigured && (
                        <button className="btn btn-review" disabled={busy || !isSupabaseAdmin} onClick={() => { void saveReadinessSnapshot(record.entityStatus) }}>Save to Supabase</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {openReadinessId && (
            <div style={{ padding: 20 }}>
              {readiness.filter(record => record.id === openReadinessId).map(record => (
                <div key={record.id} className="detail-rows">
                  {record.checklist.map(check => (
                    <div className="detail-row" key={check.key}>
                      <span className="dl">{check.label}</span>
                      <span className="dv"><span className={`status-pill ${check.passed ? 'status-documented' : 'status-missing'}`}>{check.passed ? 'Document present / checkable' : 'Missing evidence'}</span><br /><span className="td-muted">{check.detail}</span></span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'alerts' && (
        <>
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Create Manual Compliance Alert</h2>
            <div className="form-grid-3">
              <label className="field">
                <span>Entity type</span>
                <select value={alertForm.entityType} onChange={e => setAlertForm({ ...alertForm, entityType: e.target.value as ComplianceRuleEntityType })}>{RULE_ENTITY_TYPES.map(type => <option key={type} value={type}>{statusText(type)}</option>)}</select>
              </label>
              <label className="field">
                <span>Entity ID</span>
                <input value={alertForm.entityId} onChange={e => setAlertForm({ ...alertForm, entityId: e.target.value })} />
              </label>
              <label className="field">
                <span>Severity</span>
                <select value={alertForm.severity} onChange={e => setAlertForm({ ...alertForm, severity: e.target.value as ComplianceSeverity })}>{COMPLIANCE_SEVERITIES.map(sev => <option key={sev} value={sev}>{statusText(sev)}</option>)}</select>
              </label>
              <label className="field">
                <span>Linked approved rule</span>
                <select value={alertForm.linkedRuleId} onChange={e => setAlertForm({ ...alertForm, linkedRuleId: e.target.value })}>
                  <option value="">No linked rule</option>
                  {rules.filter(isRuleEnforced).map(rule => (
                    <option key={rule.id} value={rule.id}>{rule.ruleCode} — {rule.title}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field" style={{ marginTop: 14 }}>
              <span>Alert title</span>
              <input value={alertForm.alertTitle} onChange={e => setAlertForm({ ...alertForm, alertTitle: e.target.value })} />
            </label>
            <label className="field" style={{ marginTop: 14 }}>
              <span>Alert detail</span>
              <textarea rows={3} value={alertForm.alertDetail} onChange={e => setAlertForm({ ...alertForm, alertDetail: e.target.value })} />
            </label>
            <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={() => { void submitManualAlert() }}>
              {busy ? 'Saving…' : 'Create Alert'}
            </button>
          </div>
          <div className="card table-card" style={{ marginTop: 16 }}>
            <div className="table-scroll">
              <table className="inv-table inv-table--cards">
                <thead><tr><th>Severity</th><th>Entity</th><th>Alert</th><th>Status</th><th>Related rule</th><th>Actions</th></tr></thead>
                <tbody>
                  {alerts.map(alert => (
                    <tr key={alert.id}>
                      <td><span className={`badge ${SEVERITY_CLASS[alert.severity]}`}>{alert.severity.toUpperCase()}</span></td>
                      <td>{statusText(alert.entityType)}<br /><span className="td-muted">{alert.entityId}</span></td>
                      <td><span className="td-bold">{alert.alertTitle}</span><br /><span className="td-muted">{alert.alertDetail}</span></td>
                      <td><span className={`status-pill ${ALERT_STATUS_CLASS[alert.status]}`}>{statusText(alert.status)}</span></td>
                      <td>{rules.find(rule => rule.id === alert.ruleId)?.ruleCode || 'Manual / unlinked'}</td>
                      <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateAlertStatus(alert, 'in_review') }}>In review</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateAlertStatus(alert, 'blocked') }}>Block</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateAlertStatus(alert, 'resolved') }}>Resolve</button>
                        <button className="btn btn-review" disabled={busy} onClick={() => { void updateAlertStatus(alert, 'dismissed') }}>Dismiss</button>
                      </div></td>
                    </tr>
                  ))}
                  {alerts.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28 }}>No compliance alerts. Activate rules or create a manual alert.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'audit' && (
        <div className="card table-card" style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table className="inv-table inv-table--cards">
              <thead><tr><th>Created</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead>
              <tbody>
                {auditLog.map(entry => (
                  <tr key={entry.id}>
                    <td>{entry.createdAt}</td>
                    <td>{entry.actorName}<br /><span className="td-muted">{entry.actorType}</span></td>
                    <td><span className="status-pill status-reviewed">{statusText(entry.action)}</span></td>
                    <td>{entry.entityType}<br /><span className="td-muted">{entry.entityId || '—'}</span></td>
                    <td style={{ maxWidth: 420 }}>{entry.reason || '—'}</td>
                  </tr>
                ))}
                {auditLog.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 28 }}>{initialLoading ? 'Loading audit log…' : 'No audit events yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'ingestion' && (
        <WatchtowerIngestionPanel
          sources={sources}
          isSupabaseConfigured={repo.isSupabaseConfigured}
          isAdmin={isSupabaseAdmin}
        />
      )}

      {tab === 'sources' && (
        <>
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>{editingSourceId ? 'Edit Regulatory Source' : 'Add Regulatory Source'}</h2>
            <p className="td-muted">
              This registry is decision-support infrastructure for future monitoring — registering a source here
              does not fetch, check, or summarise anything, and does not create a legal update, a compliance rule,
              or any buyer-visible claim.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-review" disabled={busy} onClick={() => { void seedStarterSources() }}>
                {busy ? 'Working…' : 'Link Starter Sources'}
              </button>
              <span className="td-muted" style={{ alignSelf: 'center' }}>
                Adds a curated Tier 1-heavy starter registry and skips any source already linked by URL.
              </span>
            </div>
            <div className="form-grid-3">
              <label className="field">
                <span>Name</span>
                <input value={sourceForm.name} onChange={e => setSourceForm({ ...sourceForm, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Jurisdiction</span>
                <input value={sourceForm.jurisdiction} onChange={e => setSourceForm({ ...sourceForm, jurisdiction: e.target.value })} />
              </label>
              <label className="field">
                <span>Source type</span>
                <select value={sourceForm.sourceType} onChange={e => setSourceForm({ ...sourceForm, sourceType: e.target.value })}>
                  {SUPPORTED_SOURCE_TYPES.map(type => <option key={type} value={type}>{statusText(type)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Official URL</span>
                <input value={sourceForm.url} onChange={e => setSourceForm({ ...sourceForm, url: e.target.value })} placeholder="https://…" />
              </label>
              <label className="field">
                <span>Authority tier</span>
                <select value={sourceForm.tier} onChange={e => setSourceForm({ ...sourceForm, tier: Number(e.target.value) as (typeof SUPPORTED_SOURCE_TIERS)[number] })}>
                  {SUPPORTED_SOURCE_TIERS.map(t => <option key={t} value={t}>{SOURCE_TIER_LABELS[t]}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Authority type</span>
                <select value={sourceForm.authorityType} onChange={e => setSourceForm({ ...sourceForm, authorityType: e.target.value as (typeof SUPPORTED_AUTHORITY_TYPES)[number] })}>
                  {SUPPORTED_AUTHORITY_TYPES.map(a => <option key={a} value={a}>{statusText(a)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Category</span>
                <select value={sourceForm.category} onChange={e => setSourceForm({ ...sourceForm, category: e.target.value as (typeof SUPPORTED_SOURCE_CATEGORIES)[number] })}>
                  {SUPPORTED_SOURCE_CATEGORIES.map(c => <option key={c} value={c}>{statusText(c)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Monitoring method</span>
                <select value={sourceForm.monitoringMethod} onChange={e => setSourceForm({ ...sourceForm, monitoringMethod: e.target.value as (typeof SUPPORTED_MONITORING_METHODS)[number] })}>
                  {SUPPORTED_MONITORING_METHODS.map(m => <option key={m} value={m}>{statusText(m)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Priority (1 urgent – 100)</span>
                <input
                  type="number" min={1} max={100} value={sourceForm.priority}
                  onChange={e => setSourceForm({ ...sourceForm, priority: Math.max(1, Math.min(100, Number(e.target.value) || 100)) })}
                />
              </label>
            </div>
            <p className="td-muted" style={{ marginTop: 8, fontSize: 12 }}>
              Tier 3 (intelligence signal) sources can raise an item for human review but never act as a
              direct authority for an enforced rule — this is enforced in the database, not just here.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => { void submitRegulatorySource() }}>
                {busy ? 'Saving…' : editingSourceId ? 'Save Changes' : 'Add Source'}
              </button>
              {editingSourceId && (
                <button className="btn btn-review" disabled={busy} onClick={resetSourceForm}>Cancel edit</button>
              )}
            </div>
          </div>
          <div className="card table-card" style={{ marginTop: 16 }}>
            <div className="table-scroll">
              <table className="inv-table inv-table--cards">
                <thead><tr><th>Name</th><th>Jurisdiction</th><th>Type</th><th>Tier</th><th>Status</th><th>Last checked</th><th>Actions</th></tr></thead>
                <tbody>
                  {sources.map(source => {
                    const status = deriveRegulatorySourceStatus(source)
                    const feedEligibility = evaluateManualMonitoringEligibility(source)
                    // Source-specific policy (today: Cannamonitor). Display only —
                    // the actual enforcement happens in the policy module, the
                    // connector, and the manual-monitoring gate, not here.
                    const sourcePolicy = evaluateCannamonitorPolicy(source)
                    return (
                      <tr key={source.id}>
                        <td>
                          <span className="td-bold">{source.name}</span><br />
                          <a href={source.url} target="_blank" rel="noreferrer" className="td-muted">{source.url}</a>
                          {sourcePolicy.matched && (
                            <div
                              style={{
                                marginTop: 8,
                                padding: '8px 10px',
                                borderRadius: 6,
                                border: '1px solid #d9822b',
                                background: 'rgba(217, 130, 43, 0.08)',
                                fontSize: 12,
                                lineHeight: 1.5,
                              }}
                            >
                              <strong>Secondary commercial intelligence — non-authoritative.</strong>
                              <div style={{ marginTop: 4 }}>{CANNAMONITOR_REVIEW_HEADLINE}</div>
                              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                                {CANNAMONITOR_NON_AUTHORITATIVE_NOTICE.map(line => <li key={line}>{line}</li>)}
                              </ul>
                              <div style={{ marginTop: 6 }}>
                                <strong>Monitoring: {sourcePolicy.monitoringAllowed ? 'permitted' : 'DENIED'}</strong>
                                {' · '}
                                <strong>AI: {sourcePolicy.aiAllowed ? 'permitted' : 'BLOCKED'}</strong>
                                {' · '}
                                <strong>Permission: {sourcePolicy.permission}</strong>
                              </div>
                              {!sourcePolicy.monitoringAllowed && (
                                <div style={{ marginTop: 4 }}>{sourcePolicy.reason}</div>
                              )}
                              <div style={{ marginTop: 6 }}>
                                <strong>Detection limit:</strong> {CANNAMONITOR_DETECTION_LIMITATION}
                              </div>
                            </div>
                          )}
                        </td>
                        <td>{source.jurisdiction}</td>
                        <td>{statusText(source.sourceType)}</td>
                        <td>{source.tier ? `Tier ${source.tier}` : '—'}</td>
                        <td><span className={`status-pill ${SOURCE_STATUS_CLASS[status]}`}>{status}</span></td>
                        <td>{source.lastCheckedAt || 'Never checked'}</td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <button className="btn btn-review" disabled={busy} onClick={() => startEditSource(source)}>Edit</button>
                            {source.isActive && (
                              <button className="btn btn-review" disabled={busy} onClick={() => { void deactivateSource(source) }}>Deactivate</button>
                            )}
                            <button
                              className="btn btn-primary"
                              disabled={rssCheckBusy || !feedEligibility.eligible}
                              title={feedEligibility.eligible ? 'Manually check this public RSS/Atom feed (read-only)' : feedEligibility.reason}
                              onClick={() => { void handleCheckSourceFeed(source) }}
                            >
                              {rssCheckBusy && rssCheckSourceId === source.id ? 'Checking…' : 'Check feed'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {sources.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28 }}>No regulatory sources registered yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {rssCheckResult && (
            <div className="card" style={{ padding: 20, marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <h2 style={{ marginTop: 0 }}>
                  Manual Feed Check — {sources.find(s => s.id === rssCheckResult.sourceId)?.name ?? rssCheckResult.sourceId}
                </h2>
                <button className="btn btn-review" onClick={() => { setRssCheckResult(null); setRssCheckSourceId(null) }}>Dismiss</button>
              </div>
              <p className="td-muted">
                This checks a public regulatory feed with a read-only HTTPS request. It does not analyse, summarise,
                approve, certify, or enforce anything. From a detected change a human may explicitly create a draft
                legal update (status: new) for later human review — nothing is approved or turned into a compliance rule.
              </p>

              {!rssCheckResult.ok ? (
                <div className="disclaimer-box" style={{ marginTop: 6 }}>
                  <span className="disclaimer-icon" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '1px', color: 'var(--warning)' }}>
                    CHECK NOT COMPLETED
                  </span>
                  <div>{manualRunErrorMessage(rssCheckResult.errorCode)}</div>
                  {rssCheckResult.errorCode && <div className="td-muted" style={{ marginTop: 6, fontSize: 12 }}>Diagnostic code: {rssCheckResult.errorCode}</div>}
                </div>
              ) : (
                <>
                  <div className="detail-rows" style={{ marginTop: 6 }}>
                    <div className="detail-row"><span className="dl">Feed</span><span className="dv">{rssCheckResult.feedTitle || '—'} ({rssCheckResult.feedKind})</span></div>
                    <div className="detail-row"><span className="dl">Items</span><span className="dv">{rssCheckResult.itemCount}</span></div>
                    <div className="detail-row">
                      <span className="dl">Compared against</span>
                      <span className="dv">{rssComparedBaseline ? `Technical baseline v${rssComparedBaseline.baselineVersion} (${rssComparedBaseline.capturedAt})` : 'No saved baseline — all items first-seen'}</span>
                    </div>
                  </div>
                  {rssCheckResult.itemCount === 0 ? (
                    <p className="td-muted" style={{ marginTop: 12 }}>The feed was retrieved and parsed, but contains no items.</p>
                  ) : (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {rssCheckResult.items.map((item, i) => {
                        const pillClass = item.decisionKind === 'unchanged' ? 'status-verified'
                          : item.decisionKind === 'changed_pending_review' ? 'status-hold'
                          : item.decisionKind === 'duplicate' ? 'status-claimed' : 'status-missing'
                        const safeHref = item.itemUrl && /^https?:\/\//i.test(item.itemUrl) ? item.itemUrl : undefined
                        return (
                          <div key={i} className="disclaimer-box" style={{ marginTop: 0 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span className={`status-pill ${pillClass}`}>{manualDecisionLabel(item.decisionKind)}</span>
                              <span className="td-bold">{item.itemTitle || '(untitled item)'}</span>
                            </div>
                            <div className="detail-rows" style={{ marginTop: 8 }}>
                              {safeHref
                                ? <div className="detail-row"><span className="dl">URL</span><span className="dv"><a href={safeHref} target="_blank" rel="noreferrer">{item.itemUrl}</a></span></div>
                                : item.itemUrl && <div className="detail-row"><span className="dl">URL</span><span className="dv">{item.itemUrl}</span></div>}
                              {item.publishedAt && <div className="detail-row"><span className="dl">Published/updated</span><span className="dv">{item.publishedAt}</span></div>}
                              {item.checksum && <div className="detail-row"><span className="dl">Checksum</span><span className="dv" style={{ wordBreak: 'break-all' }}>{item.checksum}</span></div>}
                            </div>
                            {item.decisionKind === 'changed_pending_review' && rssCheckResult.sourceId === rssCheckSourceId && (() => {
                              const decision = rssCheckResult.decisions[i]
                              const drafted = rssDraftedItemIds.has(item.stableId)
                              const gate = decideDraftCreation(decision, rssDraftBusy, drafted)
                              return (
                                <button
                                  className="btn btn-primary"
                                  style={{ marginTop: 10 }}
                                  disabled={rssDraftBusy || gate.action !== 'create'}
                                  title={gate.action === 'create' ? 'Create a draft legal update (status: new) for human editing in the Review Queue' : gate.reason}
                                  onClick={() => { void handleCreateDraftFromRssItem(decision) }}
                                >
                                  {drafted ? 'Draft created' : rssDraftBusy ? 'Creating…' : 'Create Draft Legal Update'}
                                </button>
                              )
                            })()}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <div className="disclaimer-box" style={{ marginTop: 16 }}>
                    <p className="td-muted" style={{ fontSize: 12, margin: 0 }}>
                      This stores technical feed checksums for future comparison. It does not approve a legal update,
                      regulation, compliance status, or rule, and it marks nothing reviewed or approved.
                    </p>
                    {(() => {
                      const selectedSourceId = sources.find(s => s.id === rssCheckSourceId)?.id ?? null
                      const saveDecision = decideBaselineSave(rssCheckResult, selectedSourceId, rssSaveBusy)
                      return (
                        <button
                          className="btn btn-primary"
                          style={{ marginTop: 10 }}
                          disabled={rssSaveBusy || saveDecision.action !== 'save'}
                          title={saveDecision.action === 'save' ? 'Save current feed checksums as the technical baseline' : saveDecision.reason}
                          onClick={() => { void handleSaveBaseline() }}
                        >
                          {rssSaveBusy ? 'Saving…' : 'Save current feed as technical baseline'}
                        </button>
                      )
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {rssCheckSourceId && rssBaselineHistory.length > 0 && (
            <div className="card table-card" style={{ marginTop: 16 }}>
              <div style={{ padding: '16px 16px 0' }}>
                <h2 style={{ margin: 0 }}>Technical Baseline History</h2>
                <p className="td-muted" style={{ fontSize: 12 }}>
                  Technical feed-checksum snapshots only — not a record of legal review, approval, or compliance status.
                </p>
              </div>
              <div className="table-scroll">
                <table className="inv-table inv-table--cards">
                  <thead><tr><th>Baseline</th><th>Captured</th><th>Feed title</th><th>Items</th><th>Marker</th></tr></thead>
                  <tbody>
                    {rssBaselineHistory.map(b => (
                      <tr key={b.id}>
                        <td>v{b.baselineVersion}</td>
                        <td>{b.capturedAt}</td>
                        <td>{b.feedTitle || '—'}</td>
                        <td>{b.itemCount}</td>
                        <td>{rssBaselineHistory[0]?.id === b.id
                          ? <span className="status-pill status-verified">Current</span>
                          : <span className="td-muted">Historical</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

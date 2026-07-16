# DDP AI System Register

**Type:** Audit inventory (not an engineering plan). Non-runtime documentation only.
**Base commit:** `b81fa1f` (`origin/main`, "Merge pull request #27 from dylangremium-sys/fix/session-restore-on-refresh").
**Branch:** `audit/ai-governance-and-evals` · **Worktree:** `/Users/mac/ddp-ai-governance-audit`
**Method:** direct file reading at the base commit. Evidence tags follow the existing `docs/` convention: **[VERIFIED]** (observed in the code at this commit), **[JUDGEMENT]** (reasoned inference), **[UNKNOWN]** (needs evidence).
**Nothing was executed, deployed, or modified to produce this register. No provider call was made. No database was touched.**

---

## 1. Scope and the "is it actually live?" question

The single most important distinction in this register is **live runtime capability** versus **dormant interface**. This repository makes that unusually easy to get wrong, because several files carry comments asserting that no AI runs — comments that were true when written and are **now false**:

| Stale comment | Location | Reality at `b81fa1f` |
|---|---|---|
| "No implementation exists yet in this codebase — no AI API is called, no network request is made" | `src/lib/aiComplianceProvider.ts:11-13` | True of `ComplianceAIProvider` (dormant). **False** of `ComplianceAiSummaryProvider`, declared in the same file (`:99-102`) and implemented against Anthropic in `serverAiProvider.ts`. |
| "there is no production provider configured in this repository" | `src/lib/aiComplianceProvider.ts:62-64` | **False.** `DDPComplianceWatchtower.tsx:75-79` wires a live HTTP client whenever Supabase is configured. |
| "the production app injects null: no provider is configured in this repository" | `src/lib/watchtowerAiSummary.ts:60` | **False**, same reason. |
| "the provider is injected and is null in this build" | `src/pages/admin/DDPComplianceWatchtower.tsx:417` | **False**, same reason. |

**[VERIFIED]** These four comments predate Phase 2I, which wired the real path. An auditor reading the module headers alone would conclude DDP runs no AI. It does: one capability, admin-only, manually triggered. Finding **F15** in `docs/AI_THREAT_MODEL.md` and the report tracks this as documentation drift, because a governance register that inherits a false premise is worse than none.

---

## 2. Live runtime capability

**Exactly one AI capability is wired into runtime execution:** a manually-triggered, admin-only, structured **draft summary** of a single legal update's source evidence. It is transient — never persisted, never written back to the legal update.

### 2.1 Capability at a glance

| Property | Value |
|---|---|
| Capability id | `draft_summarisation` (`serverAiSummary.ts:44`, the only permitted value) |
| Trigger | Explicit admin click only — never on mount, effect, selection, feed check, or timer (`DDPComplianceWatchtower.tsx:411-413, 423`) |
| Provider | Anthropic Messages API over direct HTTPS, no vendor SDK (`serverAiProvider.ts:138-152`) |
| Model | `process.env.AI_SUMMARY_MODEL` or default `claude-opus-4-8` (`api/compliance/ai-summary.ts:42`) |
| Authority | Draft only. Cannot approve, certify, create a rule, or enforce — **[VERIFIED]** structurally, see §5 |
| Persistence | **None.** Transient React state only (`DDPComplianceWatchtower.tsx:444`) |
| Human review | Mandatory; `requiresHumanReview: true` is a literal type-level constant (`aiComplianceTypes.ts:48`) |

### 2.2 Component register — live runtime path

| Component | File path | Runtime? | Caller | Input | Output | Provider dep | Data accessed | Authority | Persistence | Human review | Test coverage | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Watchtower AI action | `src/pages/admin/DDPComplianceWatchtower.tsx:410-460` | **LIVE** | `ddp_admin` click | selected `LegalUpdate` | transient draft in React state | via client adapter | selected legal update in browser memory | none (UI only) | none — transient state | displays draft + label | indirect (controller tests) | Provider chosen by `isSupabaseConfigured`, not server capability (**F14**); stale null-provider comment (`:417`, **F15**) |
| Provider wiring | `src/pages/admin/DDPComplianceWatchtower.tsx:75-79` | **LIVE** | module init | `isSupabaseConfigured` | provider or `null` | — | none | none | none | n/a | none direct | **F14** — infers AI availability from browser Supabase config |
| UI controller | `src/lib/watchtowerAiSummary.ts` | **LIVE** | Watchtower | `LegalUpdate`, provider | outcome + safe message | injected | update in memory | none | none | messages assert review | 21 tests | `isAiSummaryProviderAvailable` only null-checks (`:61-65`) — **F14** |
| Browser HTTP client | `src/lib/complianceAiSummaryClient.ts` | **LIVE** | orchestration | provider input | sections + provenance | own endpoint only | Supabase session token | none — pure transport | none | passes `requiresHumanReview` | 6 tests | Collapses every non-2xx to one generic error and discards `requestId` (**F13**); relabels prompt version as literal `'server'` (`:114`, **F5**) |
| Guarded orchestration | `src/lib/complianceAiSummarisation.ts` | **LIVE** | client + server | `LegalUpdate`, provider | `AiDraftSummary` or coded reject | injected | `rawText` of the update | **draft only** — literal `false` capability flags (`:139-144`) | **never persists** (`:16`) | `requiresHumanReview: true` | 28 tests | Drops prompt version (`:247-265`, **F5**); `sourceReferences` bypass the wording guard (`:235-241`, **F3**) |
| Wording guard | `src/lib/aiComplianceGuard.ts` | **LIVE** | orchestration + intake | field map | safe/unsafe + findings | none — pure | text only | blocks display | none | is the review control | 16 tests | 8 English terms only; clause-wide modal bypass (`:109`, **F6**) |
| Cannamonitor AI gate | `src/lib/complianceCannamonitorPolicy.ts:343-374` | **LIVE** | orchestration (`:196-199`) | `sourceUrl` | blocked / allowed | none — pure | URL only | can only **restrict** | none | n/a | 49 tests | Keys on the recorded source URL — self-declared limitation (`:357-363`); URL is client-supplied at the server (**F1**) |
| Server endpoint (adapter) | `api/compliance/ai-summary.ts` | **LIVE** | HTTPS POST | Vercel request | HTTP result | Anthropic | `auth.getUser`, own `profiles` row | none | none | n/a | not directly testable (outside vitest glob) | Unconstrained `AI_SUMMARY_BASE_URL` / model (`:42,47-48`, **F8**) |
| Endpoint wrapper | `src/lib/serverAiSummaryEndpoint.ts` | **LIVE** | adapter | normalized request | status + body + `requestId` | injected | none | none | none | n/a | 18 tests | — |
| Server core | `src/lib/serverAiSummary.ts` | **LIVE** | wrapper | normalized request | `HttpResult` | injected | caller's own `profiles.role` | enforces admin-only | none | stamps `requiresHumanReview: true` (`:402`) | 36 tests | **Reconstructs the legal update from the request body (`:279-298`) — F1**; checksum format-only (`:246-248`, **F2**) |
| Server provider adapter | `src/lib/serverAiProvider.ts` | **LIVE** | server core | provider input | sections | **Anthropic** | full `rawEvidence` → third party | none — transport | none | sets `requiresHumanReview: true` (`:178`) | 19 tests | No prompt-injection framing (`:57-69`, **F7**); base URL/model unconstrained (**F8**) |
| Observability | `src/lib/observability.ts` | **LIVE** | endpoint | closed field set | one structured log line | none | **none by construction** | none | stdout only | n/a | 5 hits in tests | Correlation IDs are never surfaced to the user (**F13**) |

### 2.3 The one live data path

Nothing else reaches a provider. **[VERIFIED]** by following every import of `ComplianceAiSummaryProvider`: the only implementations are `serverAiProvider.ts` (server→Anthropic) and `complianceAiSummaryClient.ts` (browser→own endpoint).

---

## 3. Dormant interfaces (declared, never called)

| Component | File path | Status | Evidence |
|---|---|---|---|
| `ComplianceAIProvider` (4-method: summarise / classifyRisk / extractAffectedAreas / detectJurisdictions) | `src/lib/aiComplianceProvider.ts:20-35` | **DORMANT — no implementation exists** | **[VERIFIED]** no file implements it; no runtime call site |
| `runComplianceAnalysis` | `src/lib/aiComplianceProvider.ts:43-54` | **DORMANT** | **[VERIFIED]** only referenced by its own type imports |
| `AIComplianceAnalysisResult` | `src/lib/aiComplianceTypes.ts:67-72` | **DORMANT type** | aggregate for the above |
| `assertSafeAiDraftedText` | `src/lib/aiComplianceGuard.ts:174-180` | **DORMANT** | **[VERIFIED]** no production call site; convenience throw-wrapper |
| `AIComplianceConfidenceScore` | `src/lib/aiComplianceTypes.ts:35` | **DORMANT in effect** | Live path hardcodes `confidence: 0` (`serverAiProvider.ts:172`, `complianceAiSummaryClient.ts:111`) and never reads it |
| Cannamonitor `'verified'` permission branch | `complianceCannamonitorPolicy.ts:332-341` | **UNREACHABLE by design** | `CANNAMONITOR_PERMISSION_STATUS` is a compile-time `'unverified'` constant (`:70`); reachable only via a reviewed code edit |

**[JUDGEMENT]** The dormant 4-method interface is the most likely place for a future reviewer to mistakenly believe DDP already classifies risk with AI. It does not — see §4.

---

## 4. The `aiRiskLevel` trap (misnamed, not AI)

**[VERIFIED]** `aiRiskLevel` is **not AI-generated anywhere**. It is a deterministic pure function of human checkbox selections:

- `riskFromAreas()` — `DDPComplianceWatchtower.tsx:153-158` — a fixed lookup over `affectedAreas`.
- Assigned at `:611` (`const riskLevel = riskFromAreas(legalForm.affectedAreas)`), stored at `:630` and `:675`.
- Hardcoded `'info'` on the monitoring intake path (`:869`, `:894`).
- The **AI path sets it to `null`** (`serverAiSummary.ts:292`) and never writes it.
- It nonetheless **drives an operational consequence**: `complianceRepository.ts:256-260` maps it to review severity and `isBlocking` when `'high'`/`'critical'`.

It is the **only `ai`-named field with a real operational consequence, and no AI ever touches it.** Tracked as **F12**.

---

## 5. Authority verification — the governing principle holds

DDP's principle: *AI extracts, compares, organises and explains evidence. Humans authenticate, approve, reject, communicate and decide.*

**[VERIFIED] — structurally enforced, not merely asserted:**

| Prohibited AI authority | Status | Evidence |
|---|---|---|
| Approve legal compliance | **Impossible** | `AiDraftSummary.approvesUpdate: false` literal (`complianceAiSummarisation.ts:261`); no writer exists |
| Certify a farm/supplier/batch/document | **Impossible** | `certifiesCompliance: false` (`:264`); AI output never leaves transient state |
| Activate compliance rules | **Impossible** | `createsRule: false` (`:262`); rule creation is a separate human action |
| Reject a farm or batch autonomously | **Impossible** | no reject path consumes AI output |
| Make procurement decisions | **Impossible** | AI output never reaches `procurementControl.ts` |
| Issue Buyer Packs | **Impossible** | no import path from AI to Buyer Pack issuance |
| Publish legal conclusions | **Impossible** | draft is admin-only transient state; never buyer-facing |
| Determine export readiness | **Impossible** | no readiness writer consumes AI output |
| Communicate to farmers/buyers | **Impossible** | no messaging path consumes AI output |

**[VERIFIED]** The decisive structural fact: **no persistence path from AI output exists at all.** `DDPComplianceWatchtower.tsx:419-422` records this deliberately — a "Use as Draft Summary" action is intentionally *not* implemented because no safe repository summary-writer exists (only `updateLegalUpdateStatus`). The AI's inability to affect anything is currently guaranteed by the *absence of a writer*, which is robust today but is an **architectural accident rather than an enforced boundary**: the first PR that adds a summary-writer removes the guarantee. See `docs/AI_AUTHORITY_AND_DATA_BOUNDARIES.md` §7.

---

## 6. Tests

**[VERIFIED]** 202 AI/policy-related tests across 9 files, all provider-free (mock-injected):

| Test file | Tests | Covers |
|---|---|---|
| `complianceCannamonitorPolicy.test.ts` | 49 | source policy, host matching, projection, AI gate |
| `serverAiSummary.test.ts` | 36 | method/content-type/auth/role/validation/error mapping |
| `complianceAiSummarisation.test.ts` | 28 | request guard, shape check, wording guard integration |
| `watchtowerAiSummary.test.ts` | 21 | eligibility, stale selection, safe messages |
| `serverAiProvider.test.ts` | 19 | transport, JSON parsing, fence handling, timeout |
| `serverAiSummaryEndpoint.test.ts` | 18 | correlation IDs, no-vendor-leak logging |
| `aiComplianceGuard.test.ts` | 16 | wording guard terms, negation, scope |
| `aiSummaryBoundaryIntegration.test.ts` | 9 | end-to-end boundary with mocks |
| `complianceAiSummaryClient.test.ts` | 6 | allowlist, fail-closed, error mapping |

**Coverage gaps [VERIFIED]:** no adversarial prompt-injection fixture; no multilingual (Thai/Czech) guard case; no citation-faithfulness test; no abstention test; no checksum-recomputation test (none could pass — the behaviour does not exist); no cost/rate-limit test. These gaps are the subject of `docs/AI_EVALUATION_PLAN.md`.

---

## 7. Documentation

| Document | Relationship |
|---|---|
| `docs/DDP_AI_LEGAL_PRODUCTION_READINESS_MASTER_REPORT.md` | Engineering execution plan; explicitly *not* an audit |
| `docs/DDP_AI_LEGAL_PRODUCTION_READINESS_REVIEW.md` | Prior readiness review |
| `docs/CANNAMONITOR_WATCHTOWER_INTEGRATION.md` | Cannamonitor source policy rationale |
| `docs/AUDIT_2026_07_13_MULTI_AGENT_DUE_DILIGENCE.md` | Prior multi-agent due diligence |
| **This register + the three companion documents** | First AI-specific governance baseline |

---

## 8. Proposed capabilities (not built)

None of the following exists in any form. See `docs/AI_ONBOARDING_ROADMAP.md`.

- COA field extraction; cultivation-licence extraction; lab/certificate/batch identifiers; issue & expiry dates; THC/CBD/moisture/pesticide/microbiology/heavy-metal results.
- Form-to-document comparison; farm-name matching; duplicate-document detection; inconsistent-date detection.
- Administrator review briefs; missing-information message drafts; controlled Thai/English translation.

---

## 9. Register summary

| Category | Count |
|---|---|
| Live runtime AI capabilities | **1** (`draft_summarisation`) |
| Live components on the AI path | 11 |
| Dormant interfaces | 6 |
| Provider dependencies | 1 (Anthropic, server-side only) |
| Persisted AI records | **0** |
| AI-named fields actually written by AI | **0** |
| AI-related tests | 202 |
| Confirmed findings | 16 (see report) |

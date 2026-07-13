# Phase 2 — Evidence Review (Falsification Pass)

**Date:** 2026-07-13 · **Commit:** `f5c8cbb` · **Purpose:** attempt to disprove the Phase 1 audit's own findings.
**Method:** direct grep/read/execute against source. No subagent claim is accepted without re-verification at `file:line`.

**Result: 2 of my previous claims were overstated and are corrected below. The rest hold.**

> ### ⚠ SUPERSEDED IN PART — read before quoting this document
>
> This falsification pass describes **`f5c8cbb`**. It was committed (`9ccffab`) alongside the remediation (`94c5c42`) that falsifies its Finding 2. Left as written, as the historical record. Against the current tree:
>
> - **Finding 2 — "The immutable snapshot RPC has never been called … Zero invocations. No wrapper, no indirect call, no server-side use, no client-side use. VERIFIED FACT."** (`:60`, `:78`, `:112`). **NOW FALSE.** `src/lib/buyerPackSnapshotSupabaseStore.ts:41,114` calls `issue_buyer_pack_snapshot` via `client.rpc()`, wired at `DDPBuyerPreview.tsx:23`. The "Built ✅ / Connected ❌" row is now Built ✅ / Connected ✅.
> - **The guard's negation-window defect** described at `:148` is **fixed** (`aiComplianceGuard.ts:99`, clause-bounded token scope; seven bypass strings pinned as tests).
> - **Finding 1** (localStorage as the release-layer system of record) is **partly addressed**: a server-authoritative, append-only path now exists (`procurementDecisionStore.ts`, migration 17). It is **not** yet effective at runtime — migration 17 is still unapplied — so the *runtime* claim stands while the *code-level* claim does not.

---

## Finding 1 — "The system of record for EVERY compliance and commercial decision is browser localStorage"

### VERDICT: **OVERSTATED. The word "every" is wrong.** Corrected claim below is VERIFIED.

**What I got wrong:** farm and batch approval decisions **do** reach Supabase, with old→new status audit rows.

| | Evidence |
|---|---|
| Farm status transition → Supabase | `db.ts:294` `const farmUpdate = { status: newStatus, updated_at: ... }`; audit row at `:301-302` (`old_status`, `new_status`) |
| Batch status transition → Supabase | `db.ts:393` `const batchUpdate = { status: newStatus, ... }`; audit at `:400` |
| Core entities → Supabase | `db.ts` `.from()`: `farms` (810, 839), `inventory_batches` (867, 891), `farmer_review_requests` (485), `market_price_benchmarks` (518), `farm_memberships` (932) |
| COA upload → Supabase Storage | `db.ts:559-570` `.from('farmer-documents').upload(...)` |
| Watchtower → Supabase | `complianceRepository.ts`: `regulatory_sources` (72,84), `legal_updates` (165,175), `compliance_reviews` (270,286), `compliance_rules` (365,375), `compliance_audit_log` (621 `insertAuditLog`) |

So the **farm/batch review workflow is server-side and audited.** My Phase 1 report implied it was not. That was wrong.

### THE CORRECTED, VERIFIED FINDING

**The buyer-pack *release* layer — and only that layer — is localStorage-only, and it is NOT demo-gated.**

VERIFIED by grep (`sbConfigured` count = 0 AND supabase-import count = 0 in all five):

| Store | File | Key | Supabase import | Demo guard |
|---|---|---|---|---|
| Procurement decision | `procurementControl.ts:340,348-359` | `ddp_procurement_decisions` | **0** | **0** |
| Risk overrides | `procurementControl.ts:304,313-324` | `ddp_risk_overrides` | **0** | **0** |
| Requirement waivers | `procurementControl.ts:141,153-164` | `ddp_requirement_overrides` | **0** | **0** |
| Buyer pack snapshots | `buyerPackSnapshotStore.ts:17,24` | `ddp_buyer_pack_snapshots` | **0** | **0** |
| Buyer pack audit trail | `buyerPackAudit.ts:29,36` | `ddp_buyer_pack_audit_trail` | **0** | **0** |
| Pack downloads | `buyerPackDownloads.ts:32,39` | — | **0** | **0** |
| Monitoring snapshots | `complianceMonitoringSnapshotStore.ts:21,38` | — | **0** | **0** |

**Zero demo-mode guard means these run identically in production.** Contrast `data.ts:622-623,636-637`, where `loadInventory`/`loadFarms` *do* guard with `if (sbConfigured) return []`. The release layer has no such guard.

**Call chain (VERIFIED, live mode):**
```
DDPBuyerPreview.tsx:82   const storedDecision = loadProcurementDecisions()[item.id]
                         └─> procurementControl.ts:350  localStorage.getItem(DECISION_KEY)
DDPBuyerPreview.tsx:83   deriveBuyerApprovalGate(hasBlockingIssues, storedDecision?.decision === 'progress')
DDPBuyerPreview.tsx:141  saveProcurementDecision(item.id, decision)
                         └─> procurementControl.ts:359  localStorage.setItem(DECISION_KEY, ...)
```
The gate that authorises a buyer pack for a controlled-substance export reads a browser value in production. `StoredDecision` is `{decision, notes?, decidedAt}` — **no `decided_by`, no mandatory reason.**

**Is it cache or authoritative?** **Authoritative.** VERIFIED: no Supabase read path exists for these — there is no table to fall back to (see Finding 4). If the cache is cleared, the decision is gone, not re-fetched.

**Confidence: HIGH (executed greps, read call chain).**

---

## Finding 2 — "The immutable snapshot RPC has never been called"

### VERDICT: **VERIFIED — but my grep was narrower than my prose implied. One nuance corrected.**

**Every `.rpc()` invocation in the repo (VERIFIED, exhaustive):**
```
scripts/run-staging-security-tests.mjs:168,170,194,217,219,255,257,259   (8 calls)
src/  → ZERO      api/ → ZERO
```
So `.rpc()` **is** used — but only in the **security test script**, calling `is_ddp_admin`, `has_farm_membership`, `prevent_compliance_audit_log_mutation`, `handle_new_user` as *permission probes*. My Phase 1 wording ("the app never calls supabase.rpc()") was true of `src/` and `api/` but I should have said so precisely.

**`issue_buyer_pack_snapshot` — every reference in the entire repo:**
```
10_BUYER_PACK_SNAPSHOTS_MVP.sql:236  (definition)
                              :260,263,266  (its own RAISE EXCEPTION strings)
                              :319,321,323  (REVOKE/GRANT EXECUTE)
10_BUYER_PACK_SNAPSHOTS_VERIFY.sql:63,67  (verification queries)
```
**Zero invocations. No wrapper, no indirect call, no server-side use, no client-side use.** `grep -rn "issue_buyer_pack_snapshot" src api scripts` → nothing. **VERIFIED FACT.**

**What it was intended to do** (`10_BUYER_PACK_SNAPSHOTS_MVP.sql:236-266`): a `SECURITY DEFINER` function that refuses to issue a pack unless (a) caller is `ddp_admin`, (b) a recorded `progress` decision exists, (c) a named human approver is supplied — then writes an append-only, hash-chained snapshot protected by `prevent_buyer_pack_mutation()` (`:123`).

**What breaks because it isn't used:** every guarantee above is unenforced. The three preconditions are exactly the controls that would make a pack defensible in a dispute, and none of them run. The `buyer_pack_snapshots` / `buyer_pack_audit_log` tables have **0 references in `src/`** (VERIFIED) — they are empty.

**Effort to integrate:** 1–2 weeks. The indirection is already built for it — `buyerPackSnapshotRepository.ts` is a storage-agnostic async interface whose header comment says *"A Supabase-backed implementation can be added later purely by writing a new file that satisfies this interface; no domain or call-site logic needs to change."* The hard design work is done.

**Confidence: HIGH.**

---

## Finding 3 — Unfinished features, classified

| Class | Feature | Evidence |
|---|---|---|
| **Dead code (unreachable)** | `buyer_ready_for_discussion` status | `complianceScoring.ts:116-144` hardcodes 5 checks to `passed: false`; ladder at `:152-157` requires `missingRequirements` empty → unreachable. **VERIFIED by read.** |
| **Dead code** | `issue_buyer_pack_snapshot()` + `buyer_pack_snapshots` + `buyer_pack_audit_log` | 0 invocations, 0 `src/` references (above). **VERIFIED.** |
| **Dead code** | Tables `documents`, `ddp_scores`, `risk_flags`, `farmer_documents`, `farmer_photos` | Declared in SQL, **0 references in `src/`**. NB: `db.ts:559` uses the *storage bucket* `'farmer-documents'` (hyphen) — a different object from the `farmer_documents` *table* (underscore). **VERIFIED.** |
| **Broken (should work, does not)** | Watchtower live fetch | `browserRssFetch.ts:19-21`, author's own comment: cross-origin regulatory feeds "will typically be blocked by CORS in a real browser." **VERIFIED by read.** |
| **Broken** | Regulator notices suppressed | `complianceSourceMonitoring.ts:270` runs the **AI-output** wording guard over **raw regulator input** → a notice containing "approved"/"certified" is blocked. **VERIFIED by read + Blue Team execution.** |
| **Broken** | Heavy metals non-blocking | `complianceRules.ts:169-180` `isBlocking: false` for missing heavy-metals test. **VERIFIED.** |
| **Incomplete (started, unfinished)** | COA "intelligence" | `procurementControl.ts:183-229` re-displays farmer-entered dropdowns; no PDF parser in dependency tree. **VERIFIED.** |
| **Incomplete** | localStorage write path unguarded | `data.ts:631-633,644-646` no `sbConfigured` guard on writes (reads at `:622-623,636-637` *are* guarded). **VERIFIED.** |
| **Planned (intentional)** | Evidence Intelligence / AI Compliance Agent | `feature/evidence-intelligence-phase-a`, unmerged, synthetic fixtures only. Correctly isolated. **VERIFIED.** |
| **Future architecture (designed, intentionally unused)** | `BuyerPackSnapshotRepository` interface | `buyerPackSnapshotRepository.ts` header explicitly anticipates the Supabase swap. This is *good* design, not debt. |
| **Planned** | Buyer role | `AUTH_RLS_SCHEMA.sql:21` `CHECK (role IN ('ddp_admin','farmer'))`. Absent by design, not by bug. |

---

## Finding 4 — Architecture built but not connected

| Layer | Built | Connected? | Evidence |
|---|---|---|---|
| RPC `issue_buyer_pack_snapshot` | ✅ | ❌ | 0 invocations |
| RPC `prevent_buyer_pack_mutation` (trigger fn) | ✅ | ❌ | guards empty tables |
| Tables `buyer_pack_snapshots`, `buyer_pack_audit_log`, `buyer_pack_download_log` | ✅ + indexed | ❌ | 0 `src/` refs |
| Tables `documents`, `ddp_scores`, `risk_flags`, `farmer_documents`, `farmer_photos` | ✅ | ❌ | 0 `src/` refs |
| `BuyerPackSnapshotRepository` interface | ✅ | ⚠️ localStorage impl only | `buyerPackSnapshotStore.ts` |
| Trigger `trg_protect_farm_admin_fields` | ✅ in SQL | ❌ **absent from prod** | `FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25` — live check returns 0 rows |
| Server AI adapter | ✅ | ✅ | `api/compliance/ai-summary.ts` — the one connected server component |
| Cron / background jobs / edge functions | ❌ | — | none exist; no `vercel.json` cron. Watchtower is manual-button only |
| Feature flags | ❌ | — | none; `isSupabaseConfigured` is a build-time env check (`supabase.ts:6-10`) |
| Observability | ❌ | — | 0 hits for sentry/datadog/otel/posthog/pino |
| Payments / billing / deals | ❌ | — | 0 hits |

**Pattern (INFERENCE, high confidence):** the schema and the SQL guard layer are consistently *ahead* of the application layer. Controls are designed, migrated, VERIFY-scripted — and then not wired.

---

## Finding 5 — Score review

| Dimension | Old | New | Evidence | Confidence | What would change it |
|---|---|---|---|---|---|
| Commercial | 1 | **1** | 0 hits: commission/invoice/payment/deal/escrow/billing | HIGH | One recorded, invoiced transaction |
| Architecture | 3 | **4** ⬆ | Raised: core review flow *is* server-side (`db.ts:294,393`) — I under-credited this. Still no router, release layer in browser | MED-HIGH | Wire the release layer server-side |
| Data | 3 | **3** | Core tables `farms`/`inventory_batches`/`profiles`/`farm_profiles`/`farm_memberships`/`documents` have **0 indexes** (VERIFIED); compliance + buyer_pack tables *are* indexed | HIGH | Index the core tables |
| AI Readiness | 3 | **3** | `complianceRssConnector.ts:213` — evidence = feed fields only; `item.link` never fetched. No RAG/evals | HIGH | Fetch + version the primary source |
| AI Safety | 6 | **6** | Guard flaw real but **narrower than I claimed** (see corrections) | HIGH (executed) | Bind negation to the term |
| Security | 6 | **6** | Primitives strong; escalation test vacuous; farms policy unresolved | MED (prod state unknown) | Run the `pg_policies` query |
| Deployment | 3 | **3** | `main` auto-deploys, no gate, no observability | HIGH | Gate + Sentry |
| Compliance Rdns | 3 | **3** | Unreachable ladder; COA unread; heavy metals non-blocking | HIGH | Fix ladder + read COAs |
| Product / UX / Code / Testing | 4/4/5/4 | unchanged | — | MED-HIGH | — |

---

## CORRECTIONS TO PREVIOUS REPORT

### ❌ INCORRECT
1. **"The system of record for *every* compliance and commercial decision is browser localStorage."** Wrong. Farm and batch approvals **are** written to Supabase with old→new audit rows (`db.ts:294,301-302,393,400`). The correct claim is narrower: **the buyer-pack release layer** (procurement decision, risk/requirement overrides, pack snapshot, pack audit, downloads) is localStorage-only — but *that* is verified, and it is not demo-gated.
2. **"The AI safety guard failed 9 of 9 adversarial probes."** Overstated — I repeated a subagent claim without executing it. **I executed it.** The guard correctly **BLOCKS** `"This batch is compliant."` and `"The batch is certified and export-ready."` It is defeated only when a negation word falls within the 40-char window before the term (`aiComplianceGuard.ts:53-60`) — e.g. `"There is no doubt this batch is compliant"` → PASSED-AS-SAFE. Real, high-severity, and narrower than stated.

### ⚠️ OVERSTATED / IMPRECISE
3. **"`grep '.rpc(' src/` returns zero → the app never calls RPCs."** The grep is literally true, but `.rpc()` **is** used 8× in `scripts/run-staging-security-tests.mjs`. The precise claim: no *application* code calls RPCs, and `issue_buyer_pack_snapshot` has **zero** invocations anywhere.
4. **Architecture 3/10** was too harsh. Raised to 4 — I under-credited that the core review workflow is genuinely server-side and audited.

### 🔵 OPINION, not fact (flagged as such)
5. "You built the vault and kept the money in your browser"; "displacement activity"; the entire Brutal Truth section. These are **interpretations of a commit pattern**, not findings. The commit counts are verified; the *motive* attributed to them is not knowable from a repo. I stated it too confidently.

### ✅ VERIFIED AND STANDING
- `issue_buyer_pack_snapshot` never invoked — **VERIFIED**
- Release-layer stores have zero Supabase import and zero demo guard — **VERIFIED**
- `buyer_ready_for_discussion` unreachable — **VERIFIED**
- 0 indexes on all six core tables — **VERIFIED**
- 5 tables + 3 buyer-pack tables have zero `src/` writers — **VERIFIED**
- `trg_protect_farm_admin_fields` absent from production — **VERIFIED by the repo's own live check** (`FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25`)
- Escalation test probes `'admin'`, which the CHECK constraint rejects pre-RLS — **VERIFIED** (`run-staging-security-tests.mjs:192`; `AUTH_RLS_SCHEMA.sql:21`)
- Watchtower CORS-blocked — **VERIFIED by author's own comment** (`browserRssFetch.ts:19-21`)
- Zero billing/deal/payment code — **VERIFIED**
- No `service_role` key anywhere; AI fn uses anon key + caller JWT, fails closed — **VERIFIED (positive)**

### ❓ INCOMPLETE EVIDENCE — cannot be resolved from the repo
- **Whether `"farms: farmer update own"` is live in production.** The policy (`FARM_RESAVE_PERSISTENCE_MIGRATION.sql:104-126`) has **no column restriction**; its only guard is a trigger the repo's own live check says is **absent**. But whether the *policy* applied is **unknown**. Requires a DB query. This is the single most important open question and I cannot answer it from source.

---

## Evidence Table

| Finding | Evidence | Verified | Confidence | Priority | Action |
|---|---|---|---|---|---|
| Farmer may self-certify farm status | `FARM_RESAVE_...sql:104-126` (no column guard) + `FARM_ADMIN_ROLE_CHECK_FIX.sql:10-25` (trigger absent in prod) | **PARTIAL — policy state unknown** | MED | **P0** | Run `pg_policies` query today |
| Escalation test is vacuous | `run-staging-security-tests.mjs:192` vs `AUTH_RLS_SCHEMA.sql:21` | **YES** | HIGH | **P0** | Probe `'ddp_admin'` (10 min) |
| Release decision is localStorage-only, not demo-gated | `procurementControl.ts:340-359`; `DDPBuyerPreview.tsx:82,141`; 0 supabase imports | **YES** | HIGH | **P0** | Server-side decision table |
| `issue_buyer_pack_snapshot` never called | 0 invocations repo-wide | **YES** | HIGH | **P0** | Wire the RPC (1–2 wk) |
| localStorage write path unguarded | `data.ts:631-633,644-646`; `App.tsx:117-118`; `auth.ts:80-83` | **YES** | HIGH | **P0** | `if (sbConfigured) return` (1 hr) |
| `buyer_ready_for_discussion` unreachable | `complianceScoring.ts:116-157` | **YES** | HIGH | P1 | Split in-scope/out-of-scope |
| Watchtower CORS-blocked | `browserRssFetch.ts:19-21` | **YES** | HIGH | P1 | Disable button; proxy |
| Guard negation inversion | `aiComplianceGuard.ts:53-60` (executed) | **YES (narrowed)** | HIGH | P1 | Bind negation to term (1 hr) |
| Regulator notices suppressed | `complianceSourceMonitoring.ts:270` | **YES** | HIGH | P1 | Don't guard input |
| Heavy metals non-blocking | `complianceRules.ts:169-180` | **YES** | HIGH | P1 | Flip to blocking |
| 0 indexes on core tables | grep of all `CREATE INDEX` | **YES** | HIGH | P1 | Index FKs |
| AI never reads primary source | `complianceRssConnector.ts:213` | **YES** | HIGH | P2 | Fetch `item.link` |
| No revenue mechanism | 0 grep hits | **YES** | HIGH | P1 | Deal object |
| "System of record is localStorage" (as written) | — | **NO — OVERSTATED** | — | — | **Retracted; narrowed above** |
| "Guard failed 9/9 probes" | executed: 3/6 bypass, plain claims blocked | **NO — OVERSTATED** | — | — | **Corrected** |

---

## The Five Questions

**1. Biggest VERIFIED technical problem.**
The buyer-pack **release layer** — the procurement decision, the risk/requirement waivers, the pack snapshot, and the pack audit trail — is stored **only** in browser localStorage, with **no Supabase import and no demo-mode guard** (so it behaves this way in production), while the append-only Postgres RPC built to hold it (`issue_buyer_pack_snapshot`, with its ddp_admin + recorded-decision + named-approver preconditions) has **zero invocations**. The decision record has no `decided_by` and no mandatory reason. DDP cannot prove who authorised a pack, on what evidence, or when — and the schema literally cannot record a rejection (`10_BUYER_PACK_SNAPSHOTS_MVP.sql:59`: `CHECK (procurement_decision = 'progress')`).
*(The farms-RLS self-certification issue could outrank this — but it is unverified, and I will not rank an unverified finding first.)*

**2. Biggest VERIFIED business problem.**
There is no revenue mechanism in the codebase. Zero hits repo-wide for commission, invoice, payment, deal, quote, escrow, billing. `AUTH_RLS_SCHEMA.sql:21` permits only `ddp_admin` and `farmer`, so a buyer cannot hold an account. **The software cannot record a sale** — the revenue event of a brokerage does not exist as data.

**3. Biggest VERIFIED AI problem.**
The AI never sees the law. `complianceRssConnector.ts:213` builds the model's *entire* evidence from `[title, link, id, published, summary, content]` of the feed item — `item.link` is **never fetched**. Combined with `sourceReferences` being an unvalidated `string[]` the model invents (`complianceAiSummarisation.ts:164-166`), **no output can be traced to a legislative clause, which makes it unusable as compliance evidence.** Not the guard flaw — that is fixable in an hour; this is architectural.

**4. What did my previous report get wrong?**
Two substantive errors. (a) I said localStorage was the system of record for **every** compliance decision — false; farm and batch approvals **are** server-side and audited (`db.ts:294,393`), and I under-credited that (Architecture 3 → 4). (b) I repeated a subagent's "guard failed 9 of 9 probes" **without executing it**; on execution the guard correctly blocks plain unqualified claims and fails only on a narrower negation-window inversion. I also stated motive ("displacement activity", "hiding in the code") as if it were a finding — it is an interpretation of a commit log, and I asserted it with more confidence than the evidence supports.

**5. As CTO, three tasks tomorrow morning.**
1. **Answer the farms question (15 min, you personally).** `select policyname, cmd, qual, with_check from pg_policies where tablename='farms';` and `select tgname from pg_trigger where tgrelid='public.farms'::regclass and not tgisinternal;` — this is the only P0 nobody can answer, and it decides whether a farmer can self-approve.
2. **Fix the vacuous escalation test (10 min), then guard the two localStorage writes and clear on signOut (1 hr).** `run-staging-security-tests.mjs:192` → probe `'ddp_admin'`. `data.ts:631-633,644-646` → `if (sbConfigured) return`. These are the cheapest real risk reductions available.
3. **Start the server-side decision record (this sprint).** `procurement_decisions` table — append-only, `decided_by` FK, mandatory reason, `progress|hold|reject` — and call `issue_buyer_pack_snapshot()`. The RPC, the immutability trigger, and the repository interface are already written. This is wiring, not design.

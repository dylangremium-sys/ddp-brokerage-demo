# DDP AI Authority and Data Boundaries

**Type:** Audit documentation. Non-runtime. **Base commit:** `b81fa1f` (`origin/main`).
Evidence tags: **[VERIFIED]** / **[JUDGEMENT]** / **[UNKNOWN]**, per the existing `docs/` convention.
**Nothing was executed or modified. No provider call. No database access.**

Companion to `docs/AI_SYSTEM_REGISTER.md` (what exists), `docs/AI_THREAT_MODEL.md` (what can go wrong), `docs/AI_EVALUATION_PLAN.md` (how we would know).

---

## 1. Actors

| Actor | Trust | Authenticated | Can reach AI? | Notes |
|---|---|---|---|---|
| Farmer | Untrusted for AI purposes | yes | **No** | No AI surface exists in any farmer view **[VERIFIED]** |
| Buyer | Untrusted for AI purposes | yes | **No** | No AI surface; no AI output is ever buyer-visible **[VERIFIED]** |
| Public / anonymous visitor | Untrusted | no | **No** | Endpoint returns 401 without a bearer token (`serverAiSummary.ts:351-354`) |
| DDP administrator (`ddp_admin`) | **Trusted — and the only AI actor** | yes | **Yes** | Sole trigger; sole audience for output |
| Non-admin authenticated user | Untrusted for AI | yes | **No** | 403 on role check (`serverAiSummary.ts:372-374`) |
| DDP server function | Trusted | n/a | is the caller | Holds the only provider credential |
| Anthropic (provider) | **External, untrusted output** | n/a | is the callee | Receives evidence; its response is treated as untrusted data |
| Source publisher (regulator, RSS, Cannamonitor) | **Untrusted content author** | n/a | indirectly | Their text becomes prompt content — the injection surface |

**[JUDGEMENT]** The critical actor insight: the *source publisher* is an unauthenticated, uncontrolled party whose text flows into a prompt. They never touch DDP's systems, yet they author part of the model's input. Section 6 treats them as a first-class adversary.

---

## 2. Trust boundaries

```
  B1  Browser ─────────► DDP server        (auth boundary: token + role)
  B2  DDP server ──────► Anthropic         (data-egress boundary: irreversible disclosure)
  B3  Anthropic ───────► DDP server        (untrusted-output boundary: shape + wording checks)
  B4  DDP server ──────► Browser           (safe-error boundary: coded errors only)
  B5  Source publisher ► DDP evidence      (untrusted-content boundary: NOT ENFORCED — see F7)
  B6  AI output ───────► Persistent state  (authority boundary: NO CROSSING EXISTS — see §7)
```

| Boundary | Control | Status |
|---|---|---|
| B1 | Bearer token verified (`serverAiSummary.ts:356-364`) + `profiles.role === 'ddp_admin'` read under the caller's own RLS-restricted client (`api/compliance/ai-summary.ts:67-76`) | **[VERIFIED] Enforced.** No service-role key is used anywhere on this path |
| B2 | Field allowlist (`serverAiSummary.ts:56-67`), size bounds, Cannamonitor gate | **[VERIFIED] Partially enforced** — field-level yes, content-level no (**F10**) |
| B3 | Shape check (`complianceAiSummarisation.ts:162-172`), wording guard (`:237-245`) | **[VERIFIED] Enforced but bypassable** (**F3**, **F6**) |
| B4 | Coded errors, no vendor text, no stack (`serverAiSummary.ts:148-150`); structurally-safe logging (`observability.ts`) | **[VERIFIED] Enforced and genuinely strong** |
| B5 | — | **[VERIFIED] NOT ENFORCED** — no injection framing (**F7**) |
| B6 | No writer exists | **[VERIFIED] Not crossable today** — but by absence, not by design (§7) |

---

## 3. Data-flow diagram (live path, as built)

```
┌──────────────────────────── BROWSER (ddp_admin only) ────────────────────────┐
│                                                                              │
│  DDPComplianceWatchtower.tsx:423  handleGenerateAiDraftSummary(update)       │
│    └─ explicit click ONLY — no mount/effect/timer/feed trigger [VERIFIED]    │
│         │                                                                    │
│         ▼                                                                    │
│  watchtowerAiSummary.ts:180  Cannamonitor gate (defence-in-depth)            │
│         │                                                                    │
│         ▼                                                                    │
│  complianceAiSummarisation.ts:196  Cannamonitor gate (authoritative)         │
│  complianceAiSummarisation.ts:201  eligibility guard: status==='new',        │
│                                    evidence present, ≤20 000 chars           │
│         │                                                                    │
│         ▼                                                                    │
│  complianceAiSummaryClient.ts:77  explicit field allowlist (never spread)    │
│         │  + Authorization: Bearer <Supabase session token>                  │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │  ══════════════ B1: auth boundary ══════════════
          ▼
┌──────────────────────────── DDP SERVER (Vercel Function) ────────────────────┐
│  api/compliance/ai-summary.ts:86   newRequestId()  (CSPRNG, carries no data) │
│  serverAiSummary.ts:344            POST only              → 405              │
│  serverAiSummary.ts:347            application/json only  → 415              │
│  serverAiSummary.ts:351-364        bearer token verified  → 401              │
│  serverAiSummary.ts:366-374        profiles.role==='ddp_admin' (RLS) → 403   │
│  serverAiSummary.ts:376            strict validation: unknown fields, sizes, │
│                                    URL, checksum FORMAT ONLY (F2), status    │
│         │                                                                    │
│         ▼                                                                    │
│  serverAiSummary.ts:381  reconstructLegalUpdate(validation.value)            │
│    ▲▲▲ F1: the "authoritative record" is the REQUEST BODY. No database read  │
│        occurs. ServerAiSummaryDeps (:136-144) has no loader function.        │
│         │                                                                    │
│         ▼                                                                    │
│  complianceAiSummarisation.ts:196-245   SAME shared guarded orchestration    │
│         │                               (gate → guard → provider → shape →   │
│         │                                wording guard)                      │
│         ▼                                                                    │
│  serverAiProvider.ts:57-69  buildEvidenceText()                              │
│    ▲▲▲ F7: rawEvidence concatenated under a plain "Source evidence:" label — │
│        no delimiter, no untrusted-data framing, no ignore-embedded-          │
│        instructions directive.                                               │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │  ══════ B2: EGRESS — irreversible third-party disclosure ══════
          ▼
┌──────────────────────────── ANTHROPIC (external) ────────────────────────────┐
│  POST {AI_SUMMARY_BASE_URL || https://api.anthropic.com}/v1/messages         │
│    ▲▲▲ F8: base URL + model are env-controlled with NO allowlist. The        │
│        x-api-key travels to whatever host is configured (serverAiProvider    │
│        .ts:138-144).                                                         │
│  system: SYSTEM_PROMPT (serverAiProvider.ts:46-54) — JSON-only, no-approval  │
│  user:   Title/Jurisdiction/Source/URL/Published + raw evidence              │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │  ══════ B3: untrusted model output ══════
          ▼
┌──────────────────────────── DDP SERVER (response path) ──────────────────────┐
│  serverAiProvider.ts:111  parseModelJson — whole reply or ONE full fence     │
│  complianceAiSummarisation.ts:228  isSectionsShape → malformed_output        │
│  complianceAiSummarisation.ts:231  empty draftSummary → empty_output         │
│  complianceAiSummarisation.ts:237  wording guard over 4 AI-authored fields   │
│    ▲▲▲ F3: sourceReferences is EXCLUDED from the guard and validated         │
│        against nothing. Fabricated or unsafe citations pass unchecked.       │
│    ▲▲▲ F5: output.provenance.promptVersion is DROPPED here (:247-265).       │
│         │                                                                    │
│         ▼                                                                    │
│  serverAiSummary.ts:392-405  200 { sections, provenance{provider,model,      │
│                              generatedAt}, requiresHumanReview:true, label } │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │  ══════ B4: safe errors only ══════
          ▼
┌──────────────────────────── BROWSER (display) ───────────────────────────────┐
│  complianceAiSummaryClient.ts:99  ANY non-2xx → one generic Error            │
│    ▲▲▲ F13: 401/403/413/422/503 all become "provider_error". requestId       │
│        echoed by the server is discarded and can never be shown.             │
│  complianceAiSummarisation.ts (client re-run): shape + wording guard AGAIN   │
│  DDPComplianceWatchtower.tsx:444  setAiDraft(draft) — TRANSIENT STATE ONLY   │
│                                                                              │
│  ══════ B6: AUTHORITY BOUNDARY — NO WRITER EXISTS ══════                     │
│  No path writes the draft to legalUpdate.summary, a rule, an alert,          │
│  readiness, a Buyer Pack, or an audit-log entry.  [VERIFIED]                 │
│    ▲▲▲ F4: which also means NO DURABLE RECORD that AI ever ran.              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data classification

| Class | Definition | Present on the AI path? | May reach provider? | Enforced by |
|---|---|---|---|---|
| **Public** | Published regulatory text, official titles, source URLs | **Yes** — the intended payload | **Yes** | Field allowlist |
| **Licensed third-party** | Cannamonitor content (permission **unverified**) | Blocked | **NO — prohibited** | `CANNAMONITOR_PERMISSION_STATUS = 'unverified'` (`complianceCannamonitorPolicy.ts:70`), enforced in the shared execution layer (`complianceAiSummarisation.ts:196-199`) — **[VERIFIED] a genuine, tested, enforceable control (49 tests)** |
| **Internal** | Legal-update ids, statuses, reviewer notes | Partially (`legalUpdateId`, `status`) | Yes, minimal | Field allowlist |
| **Confidential** | Farm/buyer commercial terms, pricing, inventory | **No** — no import path | **NO** | Structural: AI path touches only `LegalUpdate` **[VERIFIED]** |
| **Personal** | Names, contacts, identifiers in a pasted document | **Possible** — free-text `rawText` | **Should not — NOT ENFORCED (F10)** | Comments only (`aiComplianceProvider.ts:79-80`, `complianceAiSummarisation.ts:44-45`) |
| **Sensitive** | Auth tokens, session data, secrets | **No** | **NO** | Allowlist never spreads input (`complianceAiSummaryClient.ts:77-88`); key is server-only, never `VITE_`-prefixed **[VERIFIED]** |
| **Prohibited from external processing** | Cannamonitor bodies; unverified-permission content; anything personal | Gate exists for Cannamonitor only | **NO** | Cannamonitor: enforced. Everything else: **not classified at all (F10)** |

**[VERIFIED] The honest summary of data minimisation:** DDP enforces minimisation at the **field level** (a closed allowlist, client and server) and at the **source level** for exactly one publisher (Cannamonitor). It enforces **nothing at the content level**. The claim in `aiComplianceProvider.ts:79-80` that the input "Contains no secrets, tokens, cookies, or buyer/farmer/personal data" is a **property of what an administrator happens to paste**, not a property the code guarantees. `rawEvidence` is unconstrained free text bounded only by 20 000 characters.

---

## 5. Evidence taxonomy — four distinct things the codebase does not fully distinguish

This distinction is the backbone of the governing principle. **[JUDGEMENT]** The system today conflates the first two and does not represent the last two at all.

| Stage | Definition | Where it lives | Trust | Represented distinctly? |
|---|---|---|---|---|
| **1. Raw source evidence** | The publisher's own words, verbatim | `LegalUpdate.rawText` | **Untrusted** — authored by an outside party | Partially: it is stored, but treated as if DDP-authored at intake (**F11**) |
| **2. Extracted candidate facts** | What AI says the source says | `sections.draftSummary`, `sourceReferences` | **Untrusted** — model output about untrusted input | **No** — no link back to a source span (**F3**) |
| **3. AI-authored conclusions** | The model's own significance/uncertainty prose | `possibleSignificance`, `uncertainties` | Untrusted; wording-guarded | Partially — guarded, but the guard is bypassable (**F6**) |
| **4. Human-reviewed facts** | What an admin confirmed against the source | — | Trusted | **Not represented** — no acceptance path exists |
| **5. Approved operational facts** | What the system may act on | `compliance_rule`, review decisions | Trusted | Yes, but with **no provenance link to any AI draft** |

**[VERIFIED]** There is no transition from 3 → 4 → 5. The draft is displayed and discarded (`DDPComplianceWatchtower.tsx:456-460`). This is *why* the AI currently holds no authority — and *why* an audit trail is absent (**F4**). Any future PR that builds the 3→4 transition **must** build the provenance record at the same time, or the governing principle becomes unverifiable after the fact.

---

## 6. Prompt construction

**[VERIFIED]** `serverAiProvider.ts:46-54` — the system prompt does real work: JSON-only output, explicit no-approve / no-certify / no-verify / no-guarantee / no-compliance-declaration / no-rule / no-buyer-facing-decision, drafts and open questions only.

**[VERIFIED]** `serverAiProvider.ts:57-69` — the user turn is a plain concatenation:

```
Title: <itemTitle>
Jurisdiction: <jurisdiction>
Source: <sourceName>
Source URL: <sourceUrl>
Published: <publishedAt ?? 'unknown'>

Source evidence:
<rawEvidence>            ← untrusted third-party text, unfenced, unframed
```

**Weaknesses [VERIFIED]:**
1. No delimiter or structural fence separates untrusted evidence from DDP's own framing. Evidence beginning `Title: X` can impersonate the metadata block.
2. No instruction to treat the evidence as data rather than instructions.
3. Five metadata fields are also attacker-influenceable in practice — at the server they arrive from the request body (**F1**), so *every* line above is client-supplied.
4. The system prompt forbids conclusions but nothing tells the model that embedded imperatives are hostile.

**[JUDGEMENT]** The system prompt is a *policy* control, not an *injection* control. It tells the model what not to conclude; it does not tell the model who to obey.

---

## 7. Authority boundary — enforced by absence, not by design

**[VERIFIED]** The AI holds no authority because **no code writes AI output anywhere**:

- `complianceAiSummarisation.ts:16` — "never persists, never writes to Supabase, never creates/approves a rule".
- `AiDraftSummary` carries literal `false` for `approvesUpdate`, `createsRule`, `enforces`, `certifiesCompliance` (`:261-264`).
- `DDPComplianceWatchtower.tsx:419-422` — the acceptance action is *deliberately absent* because no safe summary-writer exists.

**[JUDGEMENT] — the load-bearing risk in this whole register:** the guarantee rests on a missing function, not an enforced boundary. There is no test asserting "AI output must never reach persistence"; there is no type-level barrier; there is no reviewer checklist. The literal `false` flags are *documentation with a type annotation* — nothing reads them. The day someone adds `updateLegalUpdateSummary()` for an unrelated reason, the boundary silently disappears with no failing test. `docs/AI_EVALUATION_PLAN.md` §9 proposes the structural test that would convert absence into enforcement.

---

## 8. Human approval points

| Point | Human role | Enforced? |
|---|---|---|
| Trigger the AI at all | `ddp_admin` explicit click | **[VERIFIED]** yes — `:411-413, 423` |
| Read the draft | admin, with `AI_DRAFT_LABEL` shown | **[VERIFIED]** yes — label is a literal constant (`complianceAiSummarisation.ts:123`) |
| Verify each claim against the primary source | admin | **[UNKNOWN]** — no mechanism, no sampling, no attestation (**F3**, over-reliance threat T22) |
| Author the real summary | admin types it | **[VERIFIED]** yes — AI output cannot be accepted |
| Approve / reject / create a rule | admin, existing Review Queue | **[VERIFIED]** yes — untouched by AI |

---

## 9. Failure behaviour

**[VERIFIED] Fail-closed throughout**, and this is done well:

| Failure | Behaviour |
|---|---|
| No server env vars | 503 `server_misconfigured`, logged, generic message (`serverAiSummaryEndpoint.ts:56-62`) |
| No provider key | `provider: null` → `provider_unconfigured` (`api/compliance/ai-summary.ts:43-50`) |
| No session token | client refuses before any request (`complianceAiSummaryClient.ts:70-73`) |
| Invalid token / not admin | 401 / 403, no detail |
| Provider throws | generic `Error` — **never vendor text, status, body, or key** (`serverAiProvider.ts:157-160`) |
| Provider times out | `AbortError` → `provider_timeout` (30 s, `:43`, `:133-134`) |
| Malformed / empty / unsafe output | discarded before display — no partial render |
| Any unexpected exception | never logged, inspected, or returned (`serverAiSummaryEndpoint.ts:78-87`) |

**[VERIFIED]** The privacy discipline here is genuinely strong: `observability.ts` accepts only a closed set of named non-sensitive fields and passes each through a `^[a-z0-9_]{1,40}$` machine-code filter, so an exception message cannot reach a log even if a future caller passes one. **This is a control worth preserving verbatim in any refactor.**

**Weakness (F13):** this discipline is undermined at the last step — the client collapses every distinct, *already-safe* server error into one message and discards the `requestId` that the whole correlation mechanism exists to provide.

---

## 10. Audit logging

**[VERIFIED]** Every other Watchtower mutation calls `logAudit` (14 call sites: `:644, 704, 882, 906, 1016, 1090, 1121, 1153, 1193, 1226, 1268, 1293`). **`handleGenerateAiDraftSummary` (`:423-454`) calls it zero times.**

There is **no** `ai_execution` / `ai_run` / `ai_call` table in any migration **[VERIFIED]**. The only server-side trace of an AI request is a `console.error` line emitted **on failure only** (`serverAiSummaryEndpoint.ts:75`) — a successful AI call that sent a regulator's document to a third party leaves **no record anywhere**. Tracked as **F4**.

---

## 11. Prohibited AI authority — restated for the register

AI must never: approve legal compliance · certify a farm, supplier, batch or document · activate compliance rules · reject a farm or batch autonomously · make procurement decisions · issue Buyer Packs · publish legal conclusions · determine export readiness · communicate final decisions to farmers or buyers.

**[VERIFIED]** All nine hold at `b81fa1f`. §7 explains why that is currently fragile.

**On document authentication:** AI cannot authenticate a document. It can surface a **potential inconsistency** requiring **human review**; an **issuing-authority check** remains **required**; **verification is required** before any reliance. No AI output in this system may be described as establishing authenticity, and none is.

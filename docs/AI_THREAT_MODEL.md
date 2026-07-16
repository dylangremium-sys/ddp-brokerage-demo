# DDP AI Threat Model

**Type:** Audit documentation. Non-runtime. **Base commit:** `b81fa1f` (`origin/main`).
Evidence tags: **[VERIFIED]** / **[JUDGEMENT]** / **[UNKNOWN]**.
**Nothing was executed or modified. No provider call. No database access.**

Scope: the one live AI capability — admin-triggered `draft_summarisation` of a legal update's source evidence (`docs/AI_SYSTEM_REGISTER.md` §2).

---

## 1. How to read this

Likelihood and impact are **[JUDGEMENT]** calls; every control and weakness is **[VERIFIED]** against a file and line. "Blocks expansion" means: this must be resolved before the capability is extended to onboarding evidence (`docs/AI_ONBOARDING_ROADMAP.md`), because expansion multiplies the exposure.

**A note on impact calibration.** Today AI output is transient and holds no authority (`AI_AUTHORITY_AND_DATA_BOUNDARIES.md` §7), which caps *direct* impact for most output-side threats: a bad draft misleads one administrator and is discarded. Impact is therefore rated on **the harm if the finding survives into a world where AI output informs a real decision** — which is exactly what the onboarding roadmap proposes. Rating them at today's transient impact would be the mistake that lets them ship.

**The compound risk [JUDGEMENT]:** the three highest-likelihood threats chain. **T1** (injection) delivers a payload → **T3/T6** (fabricated citation, unvalidated) makes it look sourced → **T11** (guard bypass) lets a conclusion through → **T22** (over-reliance) means a busy administrator acts on it. No single control breaks this chain today.

---

## 2. Threat register

### Input and content threats

| # | Threat | Component | Likelihood | Impact | Existing control | Control weakness | Recommended control | Residual | Blocks expansion? |
|---|---|---|---|---|---|---|---|---|---|
| **T1** | **Prompt injection inside source documents** — a regulator page, RSS item, or pasted PDF contains "ignore previous instructions…" | `serverAiProvider.ts:57-69, 150` | **High** | **High** | System prompt forbids conclusions (`:46-54`); output shape check; wording guard | **[VERIFIED]** No delimiter, no untrusted-data framing, no ignore-embedded-instructions directive. Evidence is concatenated as ordinary prose under `Source evidence:` (**F7**) | Fence evidence in explicit untrusted-content delimiters; instruct the model that embedded imperatives are data, never commands; add injection fixtures (eval E5–E7) | **Medium** | **YES** |
| **T2** | **Indirect prompt injection** — payload arrives via automated RSS ingestion, unread by any human | `complianceRssConnector.ts` → `rawText` → prompt | **Medium** | **High** | Cannamonitor metadata-only projection (that source only) | **[VERIFIED]** Applies to Cannamonitor alone; every other feed's body text reaches `rawText` and then the prompt unframed | As T1, plus treat all ingested bodies as hostile by default | **Medium** | **YES** |
| **T3** | **Fabricated citations** — `sourceReferences` names a document, section, or authority that does not exist | `complianceAiSummarisation.ts:256`; `serverAiSummary.ts:399` | **High** | **High** | None | **[VERIFIED]** `sourceReferences` is validated against **nothing** and is **explicitly excluded from the wording guard** (`:235-241`) — it is the one field with no check at all (**F3**) | Require each reference to be a verbatim substring of `rawEvidence`, or drop it; render unverified references as unverified | **Medium** | **YES** |
| **T4** | **Unsupported legal conclusions** — draft asserts compliance/approval | wording guard | **Medium** | **High** | `guardAiDraftedFields` over 4 AI-authored fields (`:237-242`) | **[VERIFIED]** 8 English terms; clause-wide modal bypass (**F6**, T11) | Expand lexicon; fix modal scoping; add abstention evals | **Medium** | **YES** |
| **T5** | **Source substitution** — the evidence summarised is not the evidence recorded | `serverAiSummary.ts:279-298` | **High** | **High** | None on the server | **[VERIFIED]** The server never loads the record. `sourceName`/`sourceUrl`/`rawEvidence` come from the request body; a caller may pair any URL with any text (**F1**) | Load the authoritative row server-side by id; ignore client evidence entirely | **High** | **YES** |
| **T6** | **Citation pointing to the wrong source span** | as T3 | **High** | **Medium** | None | **[VERIFIED]** No span model exists; references are free strings | Span-anchored citations (offset + verbatim quote), validated server-side | **Medium** | **YES** |
| **T7** | **Malicious PDF / HTML text** — hidden or adversarial text reaches `rawText` | manual intake; RSS | **Medium** | **Medium** | Wording guard at intake (`Watchtower:585-590`) | **[VERIFIED]** The guard checks *wording*, not intent; and it wrongly treats source text as DDP-authored (**F11**), so it blocks honest quotations while an injection payload containing none of the 8 terms passes freely | Sanitise/normalise ingested text; separate source-evidence handling from DDP-authored-claim handling | **Medium** | No |
| **T8** | **Multilingual compliance claims** — Thai or Czech assertion of compliance | `aiComplianceGuard.ts:34-43` | **High** | **High** | English lexicon only | **[VERIFIED]** Zero non-English coverage — in a product whose two core jurisdictions are **Thailand and Czechia** (`Watchtower:154`: `'Thai export'`, `'Czech import'`). A Thai claim of compliance passes the guard untouched (**F6**) | Per-language lexicons for Thai + Czech; language detection; fail closed on undetected language | **High** | **YES** |

### Provenance and integrity threats

| # | Threat | Component | Likelihood | Impact | Existing control | Control weakness | Recommended control | Residual | Blocks expansion? |
|---|---|---|---|---|---|---|---|---|---|
| **T9** | **Client-tampered evidence** — admin token used to POST arbitrary evidence directly | `serverAiSummary.ts:376-385` | **High** | **High** | Strict validation: unknown-field rejection, sizes, URL, status enum | **[VERIFIED]** Validation checks the *shape* of client claims, never their *truth*. Status `'new'` is self-attested, so the "never summarise an actioned update" rule (`:107-109`) is decorative at the server (**F1**) | Server-authoritative load by id | **High** | **YES** |
| **T10** | **Checksum mismatch / forged provenance** | `serverAiSummary.ts:41, 246-248, 294` | **High** | **High** | `CHECKSUM_RE` format check | **[VERIFIED]** Format only. Never recomputed, never compared to a stored value. Any 64-hex string passes; the server then writes it into `reviewerNotes` (`:294`) for `buildAiSummaryRequest` to parse back out (`complianceAiSummarisation.ts:47`) — a **round-trip of an unverified value that creates a false impression of integrity** (**F2**) | Recompute the canonical hash over the persisted evidence server-side; refuse on mismatch | **High** | **YES** |
| **T11** | **Guard bypass via clause-wide modal language** | `aiComplianceGuard.ts:109` | **High** | **High** | Negation/non-assertive scope analysis | **[VERIFIED]** `NON_ASSERTIVE_TOKENS` is matched **clause-wide** (`tokens.some(...)`), not scoped to the term. Any `must`/`should`/`required`/`requires`/`if`/`when`/`unless` earlier in the clause makes the entire clause "non-assertive". *"Exporters **must** note that this batch is **compliant**"* → **passes as safe** (**F6**) | Scope non-assertive markers the way negation is already scoped (backwards, filler-skipping) | **Medium** | **YES** |
| **T12** | **Guard bypass via synonyms** | `aiComplianceGuard.ts:34-43` | **High** | **Medium** | 8-term lexicon | **[VERIFIED]** `lawful`, `authorised`, `conforms`, `meets all requirements`, `satisfies the standard`, `eligible for export`, `permitted`, `passes`, `accredited`, `endorsed` are all uncovered | Expand lexicon; consider an entailment check for claim-shaped sentences | **Medium** | **YES** |
| **T13** | **Model-version drift** — silent model change alters behaviour | `api/compliance/ai-summary.ts:42` | **Medium** | **Medium** | Model echoed in provenance (`serverAiSummary.ts:401`) | **[VERIFIED]** `AI_SUMMARY_MODEL` is free text with no allowlist; default `'claude-opus-4-8'` is a floating alias; the value is shown but never recorded (**F8**, **F4**) | Pin a model allowlist; persist the resolved model per execution; re-run evals on change | **Medium** | **YES** |
| **T14** | **Prompt-version drift** — output attributed to the wrong prompt | `complianceAiSummarisation.ts:247-265` | **High** | **Medium** | `promptVersionId` set at `serverAiProvider.ts:175` | **[VERIFIED]** Dropped in the `AiDraftSummary` mapping, absent from the response body (`serverAiSummary.ts:401`), and the client **replaces it with the literal string `'server'`** (`complianceAiSummaryClient.ts:114`). The provenance field exists end-to-end and carries no information (**F5**) | Carry `promptVersion` through the orchestration, the response and persistence | **Medium** | **YES** |
| **T15** | **Stale evidence** — evidence changed since capture | server core | **Medium** | **Medium** | None | **[VERIFIED]** No freshness or capture-time check; compounded by **F1** (no record loaded to compare against) | Load server-side; compare capture timestamp + hash | **Medium** | No |
| **T16** | **Duplicate evidence** — same evidence summarised repeatedly under different ids | server core | **Medium** | **Low** | None | **[VERIFIED]** No dedup, no idempotency key (**F9**) | Idempotency key over (id, evidence hash, prompt, model) | **Low** | No |
| **T17** | **Hallucinated dates** | model output | **Medium** | **Medium** | None | **[VERIFIED]** No date extraction, validation, or cross-check against `publishedAt` | Validate emitted dates against evidence; abstain when absent (eval E3) | **Medium** | **YES** |
| **T18** | **Hallucinated regulator names** | model output | **Medium** | **High** | None | **[VERIFIED]** No authority allowlist; a fabricated regulator in `possibleSignificance` contains none of the 8 unsafe terms and passes | Validate authority names against a known-regulator list; flag unknown authorities for verification | **Medium** | **YES** |

### Infrastructure, cost and misuse threats

| # | Threat | Component | Likelihood | Impact | Existing control | Control weakness | Recommended control | Residual | Blocks expansion? |
|---|---|---|---|---|---|---|---|---|---|
| **T19** | **Provider compromise / redirection** — evidence and the API key sent to an attacker-controlled host | `api/compliance/ai-summary.ts:47`; `serverAiProvider.ts:125, 138-144` | **Low** | **High** | Defaults to `https://api.anthropic.com` | **[VERIFIED]** `AI_SUMMARY_BASE_URL` overrides it with **no allowlist, no scheme check, no host check**. The `x-api-key` and the full evidence go to whatever host is set. Only trailing slashes are stripped (**F8**) | Allowlist permitted hosts; require https; refuse unknown hosts at startup; log the resolved base URL host | **Low** | **YES** |
| **T20** | **Accidental personal-data disclosure** — a pasted document contains personal data | `Watchtower` intake → prompt | **Medium** | **High** | Field allowlist; comments claiming no personal data | **[VERIFIED]** Field-level minimisation is real; **content-level classification does not exist**. The "no personal data" property is asserted in comments (`aiComplianceProvider.ts:79-80`) and enforced nowhere (**F10**) | Enforceable classification before egress; PII detection with fail-closed default; admin attestation at intake | **Medium** | **YES** |
| **T21** | **Excessive logging** — prompts, evidence, tokens or vendor text reach logs | `observability.ts` | **Low** | **High** | **Structurally safe**: closed field set; `^[a-z0-9_]{1,40}$` filter; raw `Error` is not accepted by the type system | **[VERIFIED] No material weakness found.** This is the strongest control on the AI path | Preserve verbatim in any refactor; keep the vendor-leak regression tests | **Low** | No |
| **T22** | **Over-reliance by human reviewers** — the draft becomes the review | UI + human process | **High** | **High** | `AI_DRAFT_LABEL` is displayed; draft is transient | **[JUDGEMENT]** A label is a weak control against a fluent, plausible summary under time pressure. **[VERIFIED]** No verification prompt, no per-claim checkoff, no sampling, no attestation — and **F3** means the citations that would let a reviewer check the work are themselves unverified | Per-claim source anchoring; require verification before use; sample-audit human reviews (eval §11) | **High** | **YES** |
| **T23** | **Replayed requests** | endpoint | **Medium** | **Low** | None server-side | **[VERIFIED]** `inFlight` (`complianceAiSummaryClient.ts:59`) and `aiDraftBusy` (`Watchtower:424`) are **per-browser-tab** and irrelevant to a direct API call (**F9**) | Idempotency key; server-side in-flight tracking | **Low** | No |
| **T24** | **Cost exhaustion** — unbounded paid provider calls | endpoint | **Medium** | **Medium** | 20 000-char evidence cap; 1 500 `max_tokens`; 30 s timeout | **[VERIFIED]** Bounds are **per request**. No rate limit, no quota, no budget, no per-actor ceiling, no spend metric. One admin token = unlimited paid calls (**F9**) | Per-actor rate limit; daily budget with fail-closed cutoff; cost metric per execution | **Medium** | **YES** |
| **T25** | **Denial of service** | endpoint | **Low** | **Low** | Auth + admin gate before any provider call | **[VERIFIED]** Good — unauthenticated traffic never reaches the provider. Residual is limited to admin-token abuse | Rate limiting (as T24) | **Low** | No |
| **T26** | **Administrator misuse** — a legitimate admin sends prohibited content, or bypasses the Cannamonitor gate by recording a different URL | `complianceCannamonitorPolicy.ts:357-363`; `serverAiSummary.ts:279-298` | **Medium** | **High** | Admin-only; Cannamonitor gate; **self-declared limitation** that attribution is by recorded URL | **[VERIFIED]** The policy honestly documents that a false/blank URL defeats it. **F1 makes this materially worse:** at the server the URL is client-supplied per request, so the gate can be bypassed **without touching any stored record** — paste Cannamonitor text, send a neutral `sourceUrl`, and the shared gate passes. No audit trail records it (**F4**) | Server-authoritative load (removes the per-request URL); durable execution log; admin attestation | **High** | **YES** |
| **T27** | **False document-authentication claims** — output read as establishing authenticity | model output + UI | **Medium** | **High** | Wording guard blocks `verified`/`certified` (unqualified) | **[VERIFIED]** Blocks the *words*, not the *implication*. "This COA matches the issuing laboratory's format and reference number" asserts authenticity while containing none of the 8 terms | Prescribed hedged vocabulary; explicit "AI cannot authenticate" UI copy; forbid authenticity-shaped claims by schema | **Medium** | **YES** |

---

## 3. Language discipline for AI output

**AI cannot authenticate a document.** No output of this system may state or imply that a document, farm, batch, or claim is authentic, valid, compliant, or approved. Permitted vocabulary:

- **potential inconsistency** — where evidence appears to disagree;
- **verification required** — where a claim is unconfirmed;
- **issuing-authority check required** — where authenticity is in question;
- **human review required** — the default for every output.

**[VERIFIED]** The existing user-facing messages already follow this discipline well (`watchtowerAiSummary.ts:125-144`) and the system prompt reinforces it (`serverAiProvider.ts:46-54`). The gap is that nothing *validates* the model's prose against this vocabulary beyond the 8-term lexicon.

---

## 4. Blocking summary

**[JUDGEMENT]** 18 of 27 threats block expansion. They reduce to five root causes, in priority order:

1. **The server trusts the client for evidence** (T5, T9, T10, T26 — findings **F1**, **F2**). One fix — server-authoritative loading with checksum recomputation — closes four high-residual threats. **This is the recommended next PR.**
2. **Model output is under-validated** (T3, T6, T17, T18, T27 — **F3**). Citations are the worst case: unvalidated *and* unguarded.
3. **The wording guard is bypassable and monolingual** (T4, T8, T11, T12 — **F6**), in a product whose jurisdictions are Thailand and Czechia.
4. **Nothing is recorded** (T13, T14, T16, T23, T26 — **F4**, **F5**). No execution log, no prompt version, no model pinning: incidents are undiagnosable after the fact.
5. **Nothing is bounded or classified** (T20, T24 — **F9**, **F10**). No budget, no rate limit, no content classification.

**Not blocking, and worth stating plainly:** authentication and authorisation (B1), fail-closed behaviour, the safe-error boundary, and the logging discipline are **[VERIFIED]** sound and should survive any refactor unchanged.

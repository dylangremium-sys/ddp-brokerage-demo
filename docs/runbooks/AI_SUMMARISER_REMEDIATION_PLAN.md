# AI draft summariser — remediation plan

**Scope:** the one AI feature in the product — the server-side compliance draft
summariser (`api/compliance/ai-summary.ts` and the `src/lib/*Ai*` modules).
**Branch:** `feature/ai-summary-hardening` (2 commits, unpushed).
**Status of prior work:** hardening + red-team fixes are **built, committed, and
CI-green** (`npm run ci:verify` exit 0, 2533 tests). Nothing below re-does that
work; this plan covers what is still open.

---

## Where things stand

Done and committed (`717c25a`, `85a9490`):

| | Change |
|---|---|
| ✅ | Token budget and thinking pinned (`thinking: adaptive`, `effort: low`, 8k budget) — a model swap can no longer silently truncate every reply into `malformed_output` |
| ✅ | Untrusted feed text neutralised and fenced in `<source_metadata>`/`<source_evidence>`; system prompt declares it material, not instruction |
| ✅ | Reference guard: model citations must be grounded in recorded evidence, and displayed text is read back out of the record, never echoed from the model |
| ✅ | Drop count carried across the wire so a reviewer sees what was discarded |
| ✅ | `provider_rejected` (503) separated from `provider_error` (502) so a misconfigured model is diagnosable |

Still open, in priority order: **P0** ship it · **P1** stop trusting
caller-supplied evidence · **P2** measure the prompt rewrite · **P3** the
architectural gap.

---

## P0 — Ship what is already built

Nothing here is code. It is the smallest set of steps that converts committed
work into running behaviour, and it must happen before P1/P2 build on it.

**Order matters.** The currently-deployed code sends `max_tokens: 1500` and no
`thinking` field. Pointing production at Claude Opus 5 *before* deploying would
turn on adaptive thinking under a 1500-token ceiling and truncate every reply.
Deploy first, switch the model second.

1. **Push and open a PR.**
   ```sh
   git push -u origin feature/ai-summary-hardening
   gh pr create --fill
   ```
   `main` is protected and `vercel.json` sets `deploymentEnabled.main = false`,
   so merging does not auto-deploy — the deploy is a separate, deliberate step.

2. **Deploy the merged code**, then smoke-test the endpoint as a `ddp_admin`
   against one `new` legal update. Expected: a draft renders, and the new
   "Source references" caption appears beneath it.

3. **Set the model explicitly.**
   ```sh
   npx vercel env rm  AI_SUMMARY_MODEL production
   npx vercel env add AI_SUMMARY_MODEL production   # value: claude-opus-5
   ```
   Set it rather than inspect it: `vercel env pull` returns `AI_SUMMARY_MODEL=""`
   (sensitive values are redacted), so the current value **cannot be read from
   the CLI**. Setting it explicitly removes the unknown instead of investigating
   it. Same price as Opus 4.8 — $5/$25 per MTok.

4. **Confirm the switch.** Re-run the smoke test. If it now fails, the failure
   is legible by design: `provider_rejected` in the response and the server log
   means the model name or request settings are wrong; `provider_error` means
   the vendor call itself failed. Roll back by setting `AI_SUMMARY_MODEL` to
   `claude-opus-4-8` — the pinned parameters are valid on both.

**Size:** S. **Risk:** low, and reversible by one env var.

---

## P1 — Make the server authoritative over the evidence ✅ DONE

**Implemented on `feature/ai-summary-server-authoritative`.** CI gate green,
2578 tests. The endpoint now reads the stored `legal_updates` row via a required
`getLegalUpdate` dep and ignores the request body's evidence entirely.

**One consequence was worse than this plan predicted, and was confirmed by probe
before it was fixed: the Cannamonitor permission gate could be walked around.**
That gate attributes by source URL and is documented as "the authoritative gate
for BOTH the client controller and the server endpoint" — but its input was
caller-supplied. A caller could declare a benign `sourceUrl` while sending
Cannamonitor evidence in `rawEvidence`, and the proprietary body reached the AI
provider with a 200. This was not a provenance-soundness issue; it was a
commercial-permission control that did not hold. It holds now — the stored row
decides. Regression tests cover it at both the unit and boundary layers.

Two smaller holes closed with it: a caller could declare `status: 'new'` for an
already-reviewed update, and could summarise an id that does not exist at all.

Also fixed while implementing: `provenanceChecksum` is recovered from
`reviewer_notes`, so the row read has to select that column — omitting it would
have silently made the checksum `null` on every request, sourcing provenance
from nowhere instead of from the record.

**Deliberately not done: the opportunistic `content_hash` check.** It would add
async hashing and a logging dependency to detect stored-data corruption, but an
attacker who can rewrite `raw_text` can rewrite `content_hash` beside it, and the
column is `NULL` on the manual-paste rows this actually runs against. It buys
nothing here.

**`reconstructLegalUpdate` was deleted, not left unused.** While a function
exists that builds a LegalUpdate out of the request body, the cheapest fix for
any future "the endpoint needs an update object" problem is to call it again.

### The defect (as found)

`handleAiSummaryRequest` builds the legal update **entirely from the request
body** (`reconstructLegalUpdate`, `serverAiSummary.ts:279`) and never reads the
stored row. `provenanceChecksum` is checked for shape only — 64 hex characters —
and never recomputed against the submitted text.

So an authenticated admin supplies the evidence, the metadata, *and* the
checksum. Every guard downstream then validates that submission against itself:
the reference guard grounds citations in caller-supplied text, and the status
eligibility check trusts a caller-supplied status. The guards are sound; their
input is not authoritative.

Severity is bounded by the fact that the caller must already hold a `ddp_admin`
JWT and the draft is transient and never persisted. It is a soundness gap in the
provenance story, not a privilege-escalation path — but "AI drafts are grounded
in recorded evidence" is the claim the whole feature rests on, and today that
claim is only as good as the client.

### Why "verify the checksum" is the wrong fix

`legal_updates.content_hash` exists (migration 25) and is SHA-256 over
`normalizeSourceContent(raw_text)` — reproducible server-side with Web Crypto,
which the runtime already has. But migration 25 added it **nullable with no
default**, explicitly so that "existing rows and manual pastes are untouched".
Watchtower intake is *currently manual paste* — there is no automated source
monitoring — so `content_hash` is `NULL` for the rows this feature actually runs
against. A checksum gate would pass vacuously exactly where it is needed.

### The fix: read the row

Fetch the record server-side and use *it*, ignoring the client's copy.

- **Feasible with no new credential.** `legal_updates` carries a
  `legal_updates: admin all` RLS policy (`9_COMPLIANCE_WATCHTOWER_MVP.sql:195`,
  `USING (public.is_ddp_admin())`). The endpoint already holds a request-scoped
  Supabase client bound to the caller's token and already uses it to read
  `profiles`. The same client can read `legal_updates` under the caller's own
  RLS. **No service-role key is introduced** — that property is preserved.

**Changes:**

1. `ServerAiSummaryDeps` (`serverAiSummary.ts:140`) gains
   `getLegalUpdate: (id: string) => Promise<LegalUpdate | null>`, alongside the
   existing `getProfileRole` — same shape, same injected-dependency style.
2. `api/compliance/ai-summary.ts` implements it against `sessionClient`,
   selecting `raw_text`, `title`, `jurisdiction`, `source_name`, `source_url`,
   `published_at`, `status`, `content_hash` by `id`.
3. `handleAiSummaryRequest` uses the fetched row as the update. The request body
   shrinks to `legalUpdateId` + `capability`; the other fields become ignored
   (accept-and-discard for one release, then remove from the client).
4. A row that does not exist → `missing_update` (400). This closes a second gap:
   today a caller can summarise an update id that does not exist at all.
5. **Opportunistic integrity check**: when `content_hash` *is* present, recompute
   it from the stored `raw_text` and log a mismatch. Cheap, and it starts
   earning value the moment automated ingestion lands.

**Tests:** the endpoint ignores submitted evidence that contradicts the stored
row; a non-existent id is rejected; the reference guard now grounds against
stored text (extend `aiSummaryBoundaryIntegration.test.ts`, which already wires
the real client to the real server core in-process).

**Size:** M — one dep, one query, one contract narrowing. **Risk:** medium; it
changes the request contract, so client and server must ship together.

---

## P2 — Measure the prompt rewrite 🟡 BUILT, NOT YET RUN

**The harness exists and is wired to the real pipeline; it has never been
executed against a live provider, because that needs a key.**

- `src/lib/aiEvalFixtures.ts` — 12 synthetic fixtures: 6 benign (including Thai
  script, a long multi-clause notice, a negated duty, and one whose *source*
  uses "certified"/"approved" so a false wording-guard block would show up), and
  6 hostile (injection in the body, in the title, a forged `</source_evidence>`,
  a demand to assert compliance, a demand to disclose the system prompt, and a
  demand to cite a specific invented regulation). None is Cannamonitor-
  attributed, so the corpus can be sent to a provider without a permission
  question — and a test asserts that stays true.
- `src/lib/aiEvalChecks.ts` — the scoring, kept pure and separate.
- `src/lib/aiSummariserEval.integration.test.ts` — the runner. Skipped unless
  `AI_EVAL_API_KEY` is set; `AI_EVAL_MODEL` and `AI_EVAL_EFFORT` make the effort
  sweep a re-run rather than an edit.

**The scoring is separated from the network on purpose.** A harness that only
executes when someone has a key would never have its own judgement tested, and a
`checkFixture` that silently returned no failures would report every run as a
clean sweep. `aiEvalChecks.test.ts` exercises it against synthetic results in
ordinary CI — 21 tests covering canary detection, the compliance-claim regex,
accepting a wording-guard block as a pass, the negation-carrying citation rule,
and the deliberate decision NOT to scan source references for canaries (they are
our text read back out of evidence that contains the canary by construction, so
scanning them would fail every injection fixture regardless of model behaviour).

**Still to do:** run it with a key, record the baseline, then sweep
`AI_EVAL_EFFORT` across `low`/`medium`/`high` and set the endpoint's effort on
evidence rather than on the judgement call currently in the code.

**Not measured: token usage.** The provider adapter deliberately discards the
vendor response beyond the content it parses, so `usage` never reaches this
layer. Latency is measured; cost is not. Surfacing tokens means widening the
adapter's return shape — a production change this harness should not force.

### The gap (as found)

The system prompt was rewritten and the user turn restructured with **zero
measurement of output quality**. Every test is mock-based: they prove the
plumbing, transport, and guards, and say nothing about whether drafts got better
or worse. `effort: 'low'` is a reasoned judgement call, not a measured one.

This is also the standing prerequisite in
`docs/DDP_AI_LEGAL_PRODUCTION_READINESS_MASTER_REPORT.md` (Work Package 5): an
eval harness and golden set gating changes in CI, before any AI expansion.

### Scope it to what is objectively measurable

Do **not** attempt to score "summary quality" — that needs a labelled corpus
this project does not have. Score *guardrail health*, which is deterministic and
is what actually protects a reviewer:

| Metric | Passing shape |
|---|---|
| Shape validity | JSON parses to the five sections; `malformed_output` rate ~0 |
| Reference grounding | discarded-reference rate per draft; a rise means the model is inventing citations again |
| Wording safety | `unsafe_output` rate on benign fixtures ~0 (no false blocks) |
| Injection resistance | on hostile fixtures, output contains no compliance claim, no leaked system prompt, no ungrounded reference |
| Cost/latency | tokens and wall-clock per draft, to make the `effort` setting an evidenced choice |

**Build:**

1. `src/lib/__evals__/fixtures/` — 12–20 legal-update fixtures: benign
   regulatory notices (several jurisdictions, English and Thai, since real
   evidence is Thai), plus hostile ones: instruction injection in the body, in
   the title, a forged `</source_evidence>`, text inviting a compliance claim,
   and one asking the model to reveal its instructions.
2. `scripts/run-ai-evals.mjs` — runs each fixture through the **real** provider,
   pinned to `promptVersionId` (already `server-draft-summary-v2`), and reports
   the table above.
3. Gated behind an env var (e.g. `AI_EVAL_API_KEY`), skipped by default — the
   same pattern as `GEOVAULT_E2E_DATABASE_URL` elsewhere. It must never make
   `npm test` depend on a network call or a paid key.
4. Record a baseline; re-run on any prompt or model change and diff.

**Then, with data in hand:** sweep `effort` across `low`/`medium`/`high` and pick
the setting on evidence rather than reasoning. That is the one open question the
harness exists to answer.

**Size:** M. **Risk:** low — additive, and cannot destabilise CI.

---

## P3 — The architectural gap (cheaper than it looks; blocked on PR #95)

**Re-scoped 2026-07-31 after measuring, not estimating.** This section previously
said P3 was "larger than P0–P2 combined". That was wrong in one direction and
right in another, and both halves matter.

**The hard part already exists.** `src/lib/serverSourceRetrieval.ts` on
`origin/feature/coa-source-bound-watchtower-review` (**PR #95, still DRAFT**) is
the first module in this codebase that actually fetches a regulatory source. It
is server-side only, deny-by-default host allowlisting, HTTPS-only, follows
redirects **manually and re-validates every hop** so an allowlisted host cannot
bounce to an internal address, resolves hostnames to catch DNS rebinding
(`api/_lib/nodeHostResolver.ts`), streams with a size cap so a lying
`Content-Length` cannot exhaust memory, enforces a content-type allowlist, and
returns a **SHA-256 `contentFingerprint`** — the source version identity P3
needs for provenance. PR #95 reports 20 red-team probes against it.

Writing that from scratch is the expensive, dangerous part of P3. It is written.

**The reference guard needs no change at all.** It already matches citations as
verbatim spans against whatever is in the stored evidence body. Point that body
at retrieved primary text and its guarantee upgrades from "traceable to a feed
summary" to "traceable to the primary source" **with no edit to the guard**. The
part everyone assumes is expensive is already done and is currently aimed at a
weak target.

**Server-side is the only route, and that is measured, not assumed.**
`docs/CSP_FEED_RETRIEVAL_DECISION.md` records that both eligible RSS sources
return no `Access-Control-Allow-Origin`, so browser retrieval fails on CORS
before CSP is even considered. Any plan that fetches from the browser is dead on
arrival.

**What is actually left:**

1. **Land PR #95, or deliberately extract the two modules.** Neither
   `serverSourceRetrieval.ts` nor `complianceSourceUrlSafety.ts` is on `main`.
   This is the real blocker, and it is someone else's in-flight work —
   duplicating the module to avoid waiting would be strictly worse than waiting.
2. **Ingestion wiring:** fetch `item.link` and store the retrieved text as the
   evidence body, with its fingerprint.
3. **A storage decision:** `raw_text` or a new column. Note the trap —
   `legal_updates.content_hash` already exists and is the SHA-256 of the
   *normalised feed text*. Overloading it with a retrieved-document fingerprint
   would silently conflate two different identities.
4. **An allowlist policy per registered source.** Deny-by-default means an empty
   list allows nothing, so this is a real content task, not a config default.

**The judgement that has not changed:** this is what decides whether an AI draft
can ever be citable compliance evidence. Steps 2–4 are ordinary work. Step 1 is
a scheduling question for the owner. Deciding to leave it is legitimate;
drifting into claiming otherwise is not.

### Original framing

`complianceRssConnector.ts:237` builds `rawText` from
`[title, link, id, published, summary, content]`, where `link` is the URL
*string*. **`item.link` is never fetched.** The primary legislative text is not
held in this system, so no output can be traced to a clause — which is why the
reference guard's guarantee stops at "traceable to stored evidence" and the UI
says so explicitly.

That is unchanged by everything above and is the ceiling on what this feature
can ever claim. Closing it means fetching and storing the primary source as the
evidence body, and citations as validated spans into that stored text. It is a
larger piece of work than P0–P2 combined, and it changes what the product can
honestly say about AI-assisted compliance.

**This plan does not schedule it.** It flags that P0–P2 make the existing
feature trustworthy *within its limits*, and that the limits stay where they are
until this is done. Deciding to leave it is legitimate; drifting into claiming
otherwise is not.

---

## Sequencing

```
P0 (ship)  ──▶  P1 (server-authoritative evidence)  ──▶  P2 (evals)
                                                             │
                                                             └─▶ effort sweep
P3 — separate decision, not scheduled here
```

P0 first: it is reversible and it validates the committed work in production.
P1 before P2, so evals measure the contract that will actually ship. The effort
sweep is the last step, because it is the only one that needs data to answer.

# DDP BROKERAGE — MASTER PLAN TO 1000/1000

**Status:** ACTIVE — sole source of truth for DDP Brokerage from 2026-08-06.
**Canonical location:** this file, `docs/MASTER_PLAN.md`. Any copy outside the repository is a mirror and loses authority the moment the two differ.
**Baseline scored:** production `0ca8a3b72f64db63bb13d6e066b22bc2665cff8d`, Supabase project `iihxjrfxmycjafbtjvvq`.
**Current score: 385 / 1000 capped (476 raw). Target: 1000 / 1000.**
**Gap: 1,546 rubric points across 101 rows.** 130 points banked 2026-08-07 — see §12.

---

## 0. WHAT THIS DOCUMENT GOVERNS

This plan supersedes every prior planning artefact for scoring and sequencing purposes.

| Document | Standing from today |
|---|---|
| `DDP_BROKERAGE_FORENSIC_PLAN_VS_ACHIEVEMENT_AUDIT_2026-08-06.md` + scorecard JSON | **BASELINE EVIDENCE.** The rubric, the 77 findings and the persona scores in this plan come from it. Do not re-derive them. |
| `DDP_BROKERAGE_FORENSIC_PLAN_VS_ACHIEVEMENT_AUDIT_2026-08-05.md` + `09.json` | **VOID. Do not cite.** Five load-bearing errors, listed in §3.4. Delete or archive out of the working tree. |
| `docs/MASTER_DEVELOPMENT_ROADMAP.md` | Retained as intent. **Superseded on facts** — §342 states no buyer role exists in the schema; production disagrees (§3.2). |
| All 18 `PHASE_*_VALIDATION.md` | Excluded, per the corpus's own instruction not to cite them in due diligence. |
| GitHub issue #77 (P0 gate, open since 2026-07-27) | **Unresolved governance item.** See §7, OWNER-01. |

**Rule of amendment.** A row's score changes only when its acceptance test in §5 passes and its evidence command in §5 is re-run and recorded. Nobody edits a score without the evidence line. Nobody edits an acceptance test to make a red result green — that is the exact failure mode that produced three of the defects below.

---

## 1. WHAT "1000" MEANS

The score is not a vibe. It is 155 enumerated rows across three personas, each with a fixed maximum, summing to exactly 1000 per persona.

**Credit scale (unchanged from the baseline audit):**

| Credit | Meaning |
|---|---|
| 100% | Proven end to end in production |
| 75% | Substantially proven, one non-critical weakness |
| 50% | Partial, or happy-path only |
| 25% | Scaffold, disconnected, unmerged, or static evidence only |
| 0% | Absent, contradicted, inaccessible, or broken |

**Overall = 0.30 × Buyer + 0.30 × Farmer + 0.40 × Admin.** Reaching 1000 overall therefore requires all three personas at 1000. There is no weighting trick that gets there faster.

**Caps.** Two penalty caps are live today: Buyer capped to 250 (a buyer cannot authenticate or make contact) and Admin capped to 450 (the primary lifecycle cannot complete). Both lift automatically once the underlying rows pass — they are consequences, not separate work.

**Say this out loud before starting:** 1000/1000 is not a bug-fix list. 438 of the 1,676 outstanding points (26%) are a buyer marketplace that does not exist in any form, and a further 227 are an evidence pipeline that stores bytes without understanding them. This is a product roadmap with a defect list at the front of it.

---

## 2. THE LEDGER — where all 1,676 points are

Computed from the baseline rows, not hand-totalled. Every row is assigned to exactly one workstream; the assertions that maxima sum to 1000 per persona and that the workstream gaps sum to 1,676 are run mechanically.

| WS | Workstream | Rows | Points | Buyer | Farmer | Admin |
|---|---|---:|---:|---:|---:|---:|
| **W0** | Unblock the pipeline (deploy path + dead contact domain) | 1 | **15** | 15 | — | — |
| **W3** | Build the buyer product | 26 | **438** | 423 | — | 15 |
| **W2** | Evidence becomes real files, registered and hashed | 12 | **227** | 60 | 142 | 25 |
| **W1** | Make the farmer journey actually work | 6 | **88** | 30 | 47 | 11 |
| **W6** | Evidence requests and notifications | 12 | **179** | — | 125 | 54 |
| **W5** | Audit trail, attribution and migration parity | 11 | **169** | 30 | 14 | 125 |
| **W10** | Localisation, accessibility, validation and recovery | 11 | **120** | 20 | 100 | — |
| **W7** | Admin operations without SQL | 8 | **119** | — | 4 | 115 |
| **W9** | Deployment provenance, backups and observability | 7 | **56** | 6 | 5 | 45 |
| **W4** | Truthful claims on every surface | 2 | **50** | 50 | — | — |
| **W8** | Watchtower rules that enforce | 2 | **35** | — | — | 35 |
| **W12** | A billable event | 2 | **25** | 15 | — | 10 |
| **W11** | PDPA / data-subject rights | 1 | **25** | — | 25 | — |
| | **TOTAL** | **101** | **1546** | **649** | **462** | **435** |

**48 rows (940 points) are already at 100%.** They are listed in §6 and are a regression list, not a work list. Losing one of them costs the same as failing to win a new one.

---

## 3. VERIFICATION RECORD — what I re-proved before writing this

Everything below was measured on 2026-08-06 against live production, the live bundle, GitHub, and the repo at `8bc13fa` (application code identical to the scored `0ca8a3b`). No claim in §5 rests on a document.

### 3.1 Confirmed — the baseline audit is accurate

| Claim | Command | Result |
|---|---|---|
| Batch insert blocker is real | `pg_constraint` on `inventory_batches` | `inventory_batches_price_requires_currency CHECK ((price_per_kg IS NULL AND asking_price IS NULL) OR price_currency IS NOT NULL)` — live |
| …and unsatisfiable by the client | binary-safe scan of 263 `.ts/.tsx` files | `price_currency` / `priceCurrency`: **0 occurrences** |
| …with no fallback | `information_schema.columns`, `pg_trigger` | default `(none)`; **0** non-internal triggers |
| …and it is actually failing | `pg_stat_user_tables` | `inventory_batches`: **1 live row, 59 insert attempts** |
| …arithmetic | `SELECT (((0::numeric IS NULL) AND (NULL::numeric IS NULL)) OR (NULL::text IS NOT NULL))` | **`f`** |
| Contact domain is dead | `dig @8.8.8.8 ddp-brokerage.com` | **NXDOMAIN**; live domain has MX at `mx1/mx2.privateemail.com` |
| …and shipped | fetch + count in `assets/index-JNM2yftY.js` | **4 occurrences** of the dead domain in the live bundle |
| Audit trail unprotected | `pg_trigger` + `has_table_privilege` | `status_history`: **0 triggers, authenticated UPDATE=true, DELETE=true** — the only log/history table like this |
| Migration 27 absent | `pg_proc` | `fn_compliance_audit_log_set_actor`: **0** |
| Migration 29 absent | `pg_proc.prosrc` | deployed `issue_buyer_pack_snapshot` contains no contaminant status: **false** |
| Migrations 47–51 absent | `pg_class` | `ai_*` tables: **0** |
| View bypasses RLS | `pg_class.reloptions` | `export_gate_overrides_pending_review`: **no reloptions**; all 3 siblings carry `security_invoker=true` |
| Security substrate strong | `pg_class`, `has_table_privilege`, `pg_proc` | RLS **49/49**; anon write tables **0**; SECURITY DEFINER pinned **82/82** |
| Commercial spine disconnected | regex over `.from('<table>')` in src+api | `organisations`, `organisation_memberships`, `reservations`, `licences`, `permits`, `documents`, `evidence_requests`, `status_history`, `ddp_scores`: **0 references each**; the app queries **18** tables total |
| Farm onboarding has no file inputs | scan for `type="file"` | **3 total, all on batch screens; 0 in farm onboarding** |
| `thaiCalendar.ts` unused | import scan | referenced only by itself and its own test |
| Deploy path broken | `gh api` over the last 14 `Security CI` runs on main | `Deploy to Production`: **12 failure, 2 success** — the 12 are the most recent |
| No human review gate | `gh api .../branches/main/protection` | `required_approving_review_count: 0`, 2 required checks, enforce_admins true |
| P0 gate still open | `gh issue view 77` | **OPEN** since 2026-07-27 |

### 3.2 Corrected — one baseline statement to retire

`docs/MASTER_DEVELOPMENT_ROADMAP.md:342` says *"No buyer role, buyer table, or buyer login exists anywhere in the schema or auth code."* Two thirds of that is false against production:

```
profiles_role_check → CHECK (role = ANY (ARRAY['ddp_admin','farmer','pending','buyer']))
public.organisations, public.organisation_memberships → both exist (0 live rows each)
```

The **buyer identity substrate is live**; what is missing is a buyer authentication path, a buyer surface, and any code that references those tables. The 2026-08-06 audit states this correctly. Fix the roadmap line so nobody re-derives the wrong conclusion.

### 3.3 New — the deploy failure cause, which the baseline left INFERRED

The baseline marked FIND-05's cause as inferred. It is now proven:

```
vercel env ls production --project ddp-brokerage-demo
  VITE_SUPABASE_ANON_KEY   Hidden   Sensitive   Production   23h ago
  VITE_SUPABASE_URL        Hidden   Sensitive   Production   23h ago
```

`vercel pull` never returns Sensitive values, so `.vercel/.env.production.local` lacks them; `vercel build --prod` runs `npm run build`; `prebuild` runs `scripts/validate-hosted-supabase-config.mjs`, which reads `process.env` and requires exactly those two names; it exits 1. The live log confirms the message verbatim:

```
> ddp-inventory-demo@0.0.0 prebuild
Missing or empty: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
Error: Command "npm run build" exited with 1
```

**And the Sensitive flag protects nothing.** Both values are already served publicly in the client bundle — the Supabase project URL and an `sb_publishable_` key are both present in `assets/index-JNM2yftY.js`, which is exactly how a browser client is meant to work. So the flag costs the entire authorised deploy path and buys zero confidentiality. This makes W0 a one-line fix rather than a project.

### 3.4 The 2026-08-05 audit — why it is void

Recorded so nobody resurrects it: it scored the broken batch-submission path **170/170 "PROVEN"** citing a function declaration; asserted no buyer role exists (false, §3.2); applied a large penalty for being unable to verify production while production was live and publishing its own commit; printed an Admin total of 710 against rows summing to 810 and an overall of 275 against a mean of 250; claimed the branch was 12 commits behind when it was 1; and cited zero of the repository's 168 SQL files while grading RLS.

---

## 4. SEQUENCE

Each phase has an exit gate. Do not start the next phase until the gate passes — the gates exist because this project's characteristic failure is building the next layer on an unverified one.

| Phase | Workstreams | Points | Exit gate |
|---|---|---:|---|
| **P0 — Unblock** | W0 | **15** | A merge to `main` produces a green `Deploy to Production` including step 9, and every published contact address resolves and receives mail |
| **P1 — A farm can trade** | W1 (88 left) + W10.1–10.2 (53) + W5.2–5.4 (50) | **191** | A real farmer account submits a priced batch; the row exists; a forced DB error renders an error, not a success screen |
| **P2 — Evidence is real** | W2 (227) + W6 (179) | **406** | A COA upload produces a storage object **and** a register row **and** a digest; the farmer is notified of an evidence request and can respond |
| **P3 — Operable and auditable** | W5 remainder (119) + W7 (119) + W8 (35) + W9 (56) | **329** | Zero of the 19 routine tasks require raw SQL; `status_history` is append-only and attributed; an approved compliance rule demonstrably blocks a pack |
| **P4 — The buyer product** | W3 (438) + W4 (50) + W12 (25) | **513** | A provisioned buyer signs in, finds a batch, requests a pack, receives it, and cannot see any other buyer's data or any farm identity DDP has not disclosed |
| **P5 — Rights and polish** | W11 (25) + W10 remainder (67) | **92** | A data-subject deletion request completes through the product; the four known accessibility violations are closed |
| | **TOTAL** | **1546** | Every persona at 1000 |

**Why W3 is last despite being the largest.** A buyer catalogue with nothing in it is worth zero points and negative credibility. The catalogue is only meaningful once farms can list (P1) and evidence is real (P2). Building it first would produce a demo, which is precisely what this project already has too much of.

---

## 5. WORKSTREAMS

Each item states the defect, the work, the acceptance test (what proves it), and the evidence command (how the score is re-measured). Points are the rubric points recovered.

### W0 — Unblock the pipeline · 15 points remaining · **W0.1 CLOSED, scored §12**

**W0.1 — The authorised deploy path (A-D1 15, A-D2 10) — ✅ CLOSED 2026-08-07, scored in §12.**
Merging a PR does not ship it, and nothing says so. 12 consecutive `Deploy to Production` failures; production ships only from a developer's CLI; step 9 — "verify the live site serves this exact commit" — has never executed once.

- **Primary fix:** remove the `Sensitive` designation from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel Production so `vercel pull` returns them. Both values are already public in the shipped bundle (§3.3), so nothing is disclosed that isn't already disclosed.
  - Recover the values first from the Supabase dashboard (do not scrape the bundle for the write path).
  - `vercel env rm <NAME> production` **deletes the whole record** — have the value in hand before removing.
  - Re-add without the Sensitive flag, Production scope only.
- **Do not** widen scope to Preview. Preview intentionally has no `VITE_*` vars; preview builds must keep failing, because a preview built without Supabase runs in demo mode where `App.tsx:502-505` makes every anonymous visitor an admin. A red Vercel check on a PR is that guard working.
- **Alternative if the flag must stay:** add both as GitHub Actions secrets and set them in the `Build with Production configuration` step's `env:` block. Verify in a dry run that Vite picks up prefixed vars from `process.env` — do not assume it.

**Acceptance:** one merge to `main`; `Deploy to Production` green through step 9; `/version.json` `commitSha` equals the merge SHA.
**Evidence:** `gh run list --workflow=security-ci.yml --branch=main --limit 3` then `curl -s https://ddpbrokerage.com/version.json`.

**W0.2 — The dead contact channel (B-A4 15).**
Both published contact addresses sit on `ddp-brokerage.com`, which does not exist. Every buyer enquiry bounces unseen, and the domain is registrable by anyone for ~$10 — who would then receive DDP's inbound buyer correspondence.

- Correct `src/translations.ts:194-195` (EN) and `:786-787` (TH) to the live domain.
- Defensively register `ddp-brokerage.com` and redirect it. This is cheap insurance against an impersonator, independent of the copy fix.
- Add a build-time check that fails if any domain in the bundle lacks an MX record.

**Acceptance:** `dig MX` resolves for every published address; a test message is received; **0** occurrences of the hyphenated domain in the built bundle.
**Evidence:** `dig +short <domain> MX` and a byte-count of the deployed asset.

---

### W1 — Make the farmer journey actually work · 193 points

Every priced batch submission is rejected by the database with SQLSTATE 23514, and the farmer is shown a full-screen success confirmation. That is why production holds one batch after 59 insert attempts. Four code-level defects, all small:

**W1.1 — Send the currency (F-B2 50, B-P3 15, B-M3 15).** Add `price_currency` to the upsert in `src/lib/db.ts:510-556`. The live CHECK allows `THB`, `USD`, `EUR`. Add a currency control to the batch form; default THB (owner-confirmed as the pricing currency). Do **not** add a column default in the database as the fix — the application must state its currency explicitly, or the same class of bug returns the first time a non-THB price appears.

**W1.2 — Stop sending blanks (no separate row; required for W1.1 to pass).** `db.ts:517-519` passes `harvest_date`, `cure_date` and `batch_number` through as `''`, which fails both `''::date` and the not-blank CHECKs. Coerce empty strings to `null` at the payload boundary, not per-field at each callsite.

**W1.3 — Tell the truth on failure (F-B3 25, F-S2 15, F-R1 20).** The boolean result dies at a type boundary: `App.tsx:773-802` returns `Promise<boolean>`, `mutationCommit.ts:31-34` swallows it, and `FarmerSubmitInventory.tsx:15` types the prop `void | Promise<void>` so `tsc -b` cannot see the loss. Narrow the prop type to `Promise<boolean>`, propagate the result, and gate `setSubmitted(true)` (`:262`) on it. Then fix the sibling defect: a farmer's **failed** stock load currently renders "No stock yet" — an error must never render as an empty state.

**W1.4 — A test that could have caught it (F-B1 15, F-B7 7, F-V2 20, A-C1 11).** 3,001 tests pass and none of them insert a batch through the client's own payload builder against a schema-accurate database. Add one integration test that runs the real builder against the disposable-Postgres harness with production's constraints loaded. Without this, W1 is a fix; with it, W1 is a fix that stays fixed.

**Acceptance:** with a real farmer session, submit a priced batch → the row exists and is visible to the farmer; force a DB error → an error state renders and no success screen appears.
**Evidence:** `SELECT n_live_tup, n_tup_ins FROM pg_stat_user_tables WHERE relname='inventory_batches'` before and after — live rows must increase by exactly the number of successful submissions.

---

### W2 — Evidence becomes real files, registered and hashed · 227 points

DDP stores bytes it does not understand. `farmer_documents` occurs **0 times** in the codebase while being created and exercised by migrations 15, 22, 28 and 42. Three files sit in storage against **0** register rows. Migration 28's `sha256_hex` index is live and will never hold a row. Farm-level licences are typed as text, so the evidence the product is premised on arrives over LINE — outside the system and outside backup.

- **W2.1 (F-O7 25, F-E5 20, B-E2 20):** file inputs on farm onboarding for licences, permits and certificates. There are currently **zero**.
- **W2.2 (F-E3 20, A-F3 25, B-E1 25):** write a `farmer_documents` row for every upload; build the admin document review surface the register was designed for.
- **W2.3 (F-E6 15, B-E7 15):** hash on upload; store in `sha256_hex`. Without this DDP cannot claim even integrity-since-upload.
- **W2.4 (F-E2 25):** fix the batch-photo arity mismatch — the photo argument is never forwarded, `n_tup_ins` is 0. Note a source-text test currently **pins the broken callsite**; that test must change with the fix.
- **W2.5 (F-E4 15, F-E1 7):** real size caps and content-type detection; `contentType` is currently hard-coded to PDF and the gate is extension-only.
- **W2.6 (F-V1 15):** malware/content scanning on every upload path, and the last gap between "a farm can complete onboarding" and "a farm can complete onboarding with its evidence in the system".

**Acceptance:** one COA upload produces a storage object, a register row, and a digest; the admin sees it in review; the buyer pack renders it.
**Evidence:** `SELECT count(*) FROM pg_stat_user_tables WHERE relname IN ('farmer_documents','documents','farmer_photos')` — currently 0 rows across all three — plus a storage object listing.

---

### W3 — Build the buyer product · 438 points · the largest single block

Nothing here is broken; it is absent. 32 of 32 buyer requirements are unbuilt. The schema substrate exists and is live (`organisations`, `organisation_memberships`, migration 44 reservations, migration 46's verified-buyer read predicate) with **0 rows and 0 code references**.

- **W3.1 Identity (B-A1 15, B-A2 15, B-A3 20, A-C2 15):** add `buyer` to `UserRole` (`auth.ts:16`); `resolvePostLoginDecision` currently falls a buyer to `default:` → `signOut()`. Add buyer routes to the `Page` union. Buyers are DDP-provisioned only — never self-registered.
- **W3.2 Organisations (enables B-A2 above):** admin CRUD over `organisations` / `organisation_memberships`; qualification and KYC status; per-buyer pack access records. No points of its own — it is the substrate the rest of W3 scores against.
- **W3.3 Catalogue (B-D1 35, B-D2 5, B-R4 20):** a buyer-facing RLS policy on `inventory_batches` — there are 5 policies today and none is buyer-facing. Wire migration 46's predicate to a real surface.
- **W3.4 Discovery (B-D3 20, B-D4 20, B-D5 20, B-D6 25):** server-side search, filter, compare and pagination. Client-side filtering on an unpaginated list does not earn these rows at any volume.
- **W3.5 Presentation (B-P1 15, B-P2 11, B-P4 11, B-P5 11, B-P6 15, B-E3 15, B-E4 4):** batch identity, quantity, dates, availability, cannabinoid data, evidence taxonomy and human-review status. Price-with-currency is scored under W1.1, because the currency has to exist in the row before a buyer surface can render it.
- **W3.6 Workflow (B-W1 30, B-W2 25, B-W3 15, B-W4 6, B-W5 15):** enquiry, RFQ, reservation against migration 44's ledger (oversell protection is already proven at 8-way concurrency), pack delivery to an authenticated buyer — replacing `window.print()`.
- **W3.7 Isolation (B-C4 20, B-U2 15, B-M1 20):** buyer-to-buyer isolation and farm-identity double-blind, proven by test with a real second buyer identity — not by inspection.

**Acceptance:** a provisioned buyer signs in, finds a batch, compares two, requests a pack, receives it, and can read nothing belonging to another buyer or any farm identity DDP has not disclosed.
**Evidence:** a second buyer identity in an integration test, asserting 0 rows visible across the isolation boundary, with a positive control proving the query would have returned rows if permitted.

---

### W4 — Truthful claims on every surface · 50 points

**B-P7 25 and B-E6 25.** The buyer artefact shows an "11/11 passed" compliance checklist that is **field-presence only** — it counts non-empty fields, it does not verify anything. Shipping that to a buyer is the single most dangerous claim in the product, because it is the one a buyer would rely on.

- Replace it with a statement of what was actually checked, by whom, and when — or remove it.
- Audit every public and pack-facing claim against what the system can prove. The corpus already contains "Only qualified buyers access sensitive information" (no buyer portal exists) and "Experienced reviewers authorise every decision" (0 decision rows).
- Keep the disclaimers that are already correct — DDP does **not** certify export, pharmaceutical or legal compliance, stated in English and correct Thai. That row is at 100% and is worth defending.

**Acceptance:** every claim rendered to a buyer maps to a stored fact with a recorded human decision.
**Evidence:** claim-to-evidence table reviewed against the rendered pack; no claim without a backing row.

---

### W5 — Audit trail, attribution and migration parity · 169 points

- **W5.1 (A-E3 25):** `status_history` — the record of every farm and batch status decision — has **0 protective triggers** and grants `authenticated` both UPDATE and DELETE. Every sibling log table has 2 triggers. Add `no_truncate` + `no_update_delete`, revoke the grants, add an actor column.
- **W5.2 (A-E4 20):** apply migration 27. `fn_compliance_audit_log_set_actor` is the **one** function of 97 missing from production, so `compliance_audit_log.actor_id` is whatever the browser sends — in an append-only table where a forged entry is permanent. The source comment claims a trigger protects it; it does not.
- **W5.3 (A-B4 15):** apply migration 29. The deployed `issue_buyer_pack_snapshot` is migration 23's body with no contaminant status, so with an admin override a permanent snapshot can be issued for a batch carrying a failed laboratory result.
- **W5.4 (A-S7 15):** apply migrations 30 and 47–51 or formally retire them. No `ai_*` table exists in production. Migration 51 is currently unappliable and its `IF EXISTS` guards leave it silently half-secure.
- **W5.5 (A-S6 20):** set `security_invoker=true` on `export_gate_overrides_pending_review`. It is owned by `postgres` (`rolbypassrls = true`) and grants `authenticated=r`; all three sibling views carry the flag. It leaks on the first override row written. Then evaluate `FORCE RLS` — currently 0 of 49 tables.
- **W5.1b (A-E5 5):** `buyer_pack_audit_log` and `buyer_pack_download_log` carry their append-only triggers, but `authenticated` still holds UPDATE and DELETE on both — verified 2026-08-06. The triggers are doing all the work alone. Revoke the grants so the protection is two-layer, as it already is on `commercial_audit_log` and `compliance_audit_log`.
- **W5.6 (B-W6 10, A-B5 25, B-W7 20):** compute the buyer-pack hash **server-side** — today it is computed in the browser and stored verbatim behind a `^[0-9a-f]{64}$` format check, which makes "immutable" mean "unchanged since the client said so". Move the pack issuance and download audit trail out of admin `localStorage` into the tables that already exist, and give them a reader.
- **W5.7 (F-T4 12, F-A7 2):** test storage-object isolation. Migration 24's 18-section VERIFY reads `storage.objects` **zero times** and impersonates a farmer **zero times** — the evidence file-access rules are untested. Tighten the `farmer-documents` upload policy, which omits the role check its sibling has.

**Acceptance:** every migration in the repo is applied or formally retired, with a register entry; `status_history` refuses UPDATE and DELETE; a forged actor id is rejected.
**Evidence:** the migration-parity query (97 declared vs live functions), the trigger/privilege matrix over all log tables, and `pg_class.reloptions` for all four views.

---

### W6 — Evidence requests and notifications · 179 points

Migration 24 deployed **23 RPCs** that are called by nothing, and **no notification mechanism of any kind exists** — no queue, no scheduled job, no outbound channel. A farmer cannot be told anything, so the review loop cannot close.

- **W6.1 (A-E1 19, A-E2 20, F-R4 25, F-R5 25):** wire migration 24's workflow end to end, including the farm-level request path that currently hard-codes `farm_id` to null and dead-ends.
- **W6.2 (F-R6 25, A-O2 15, F-A2 5):** one notification channel, in-app at minimum, with delivery recorded. Do not claim email/SMS/LINE capability until one exists and is proven.
- **W6.3 (F-A4 11, F-A5 4):** confirm custom SMTP in the Supabase project (owner action, §7) so invitations arrive at volume rather than via the `link_only` hand-off.
- **W6.4 (F-R2 5, F-R3 15):** surface `status_history` — it is written by `db.ts` and read by **0** UI files.
- **W6.5 (F-S3 10):** a support path for a stuck farmer.

**Acceptance:** an admin raises an evidence request; the farmer is notified in-product, responds with a file, and the request closes with an attributed history entry.
**Evidence:** row counts on `evidence_requests` / `evidence_request_history` moving from 0, plus a delivery record.

---

### W7 — Admin operations without SQL · 119 points

Nineteen routine operations require raw SQL, the Supabase dashboard, or the developer. Two of them are recovery paths the product itself tells the admin to use.

- **W7.1 (A-A4 10):** approve a pending account by id. The provisioning endpoint's own 502 instructs the admin to use this path; `provisionFarmer` / `listPendingProfiles` are re-exported at `services/auth.ts:294,305` and imported by **zero** components.
- **W7.2 (A-A5 15, A-A6 10):** suspend / demote / de-provision, and promote a second admin.
- **W7.3 (A-I3 20):** capture a reason on every approve/reject. None is captured today, which is what makes W5.1's audit trail thin even once it is protected.
- **W7.4 (A-I6 15):** paginate master inventory — currently unpaginated with O(B²) behaviour and silent PostgREST truncation at scale.
- **W7.5 (A-F2 20):** farm scoring/completeness — `ddp_scores` has 0 rows and the panel is suppressed.
- **W7.6 (A-O1 25, F-A3 4):** work down the remaining SQL-only tasks: duplicate emails, supplier email changes, counterparty organisations, licences and permits, destination rulesets, export evaluations, gate overrides, reservations, market benchmarks **that real farmers are already shown**, document replacement, pack provenance questions, PDPA deletion.

**Acceptance:** a named operator with no database access completes all 19 tasks through the product.
**Evidence:** the task list walked, each with a screenshot or a resulting row.

---

### W8 — Watchtower rules that enforce · 35 points

The governing principle is *AI detects → AI summarises → human reviews → approved rule → **system enforces***. The first four links are real and among the best-built things in the codebase. The fifth does not exist: `compliance_rules_in_force()` and `compliance_rules_currently_enforced()` are live in production **with zero callers**. The buyer-pack gate computes blockers from an entirely separate source and never reads `compliance_rules`.

- **W8.1 (A-W6 30):** connect the enforcement primitive to the buyer-pack gate and the export-eligibility gate.
- **W8.2 (A-W5 5):** close the human-review lifecycle so the compliance audit log stops being empty.

**Acceptance:** approving a rule in the Watchtower demonstrably blocks a pack that would otherwise issue; revoking it unblocks.
**Evidence:** a before/after pack issuance attempt with the rule toggled, and the corresponding audit rows.

---

### W9 — Deployment provenance, backups and observability · 56 points

- **W9.1 (A-O3 20):** monitoring and alerting. There is none — the batch-insert blocker ran for 59 attempts unnoticed.
- **W9.2 (A-D4 5, F-S4 5):** the storage backup has run **once, manually**; the scheduled workflow (`17 3 * * *`) has never fired. Confirm it fires, or fix it.
- **W9.3 (A-D5 5):** verify database PITR (owner action, §7).
- **W9.4 (A-O4 15):** runbooks beyond migration and credential procedures — all 11 existing ones are in those two categories.
- **W9.5 (B-R5 4, B-R3 2):** keep build self-identification working (fixed in #150; do not regress it) and split the 976 KB single bundle.

**Acceptance:** a deliberately broken production path raises an alert to a human within an agreed window; a restore is performed from an unattended backup.
**Evidence:** the alert, and a cold restore of a real file from a scheduled (not manual) artifact.

---

### W10 — Localisation, accessibility, validation and recovery · 120 points

- **W10.1 (F-O3 20):** the ~120-field farm profile has **zero** validation.
- **W10.2 (F-O4 7, F-O5 15, F-U6 11):** the draft is raw unguarded `localStorage`; a farmer who changes device or signs out loses the lot. Move it server-side.
- **W10.3 (F-U2 19):** Thai is unreachable from `/farmer` — the primary cold-load path, and the one on the QR code. The toggle renders only under `isDemo` and the language is never persisted.
- **W10.4 (F-U4 10):** `thaiCalendar.ts` — 296 lines, tested, imported by nothing. Wire it or delete it; Buddhist-Era dates are not optional for Thai farms.
- **W10.5 (F-U1 5, F-U5 7, B-U4 10, B-U3 10):** the four known accessibility violations — contaminant/COA toggle state is CSS-only and invisible to assistive technology; the farmer form has no heading structure (`SectionTitle` renders a `<div>`); no focus management on the submit→success swap; 14px inputs cause iOS auto-zoom with ~38px tap targets.
- **W10.6 (F-O2 6):** close the remaining data-class gaps in the profile.

**Acceptance:** a Thai-speaking farmer completes onboarding on a 375px phone, in Thai, from the QR link, with validation feedback, and can resume after closing the browser on another device.
**Evidence:** an axe run with zero violations on the farmer surfaces plus a recorded walkthrough.

---

### W11 — PDPA / data-subject rights · 25 points

**F-T6 25.** There is no deletion path anywhere in the product, and the Privacy Policy and Terms are inert. Thai PDPA applies to the personal data of farm contacts already in the system.

**Acceptance:** a data-subject deletion request completes through the product, with an audit record and a defined retention exception list.
**Evidence:** the request, the resulting rows, and the retained-by-exception list.

---

### W12 — A billable event · 25 points

**A-C3 10, B-M2 15.** No billable event exists anywhere in the product — 0 of 11 planned revenue streams. Nothing here needs to be a payment integration on day one; it needs a recorded, priced, attributable commercial event that a buyer can trigger and DDP can invoice against.

**Acceptance:** a buyer action creates a priced, attributable commercial record.
**Evidence:** the record, with currency, counterparty and timestamp.

---

## 6. THE 48 ROWS ALREADY AT 100% — defend these

940 points are already banked. They are, by category: anonymous read/write lockout with a positive control · RLS on 49/49 tables · 82/82 SECURITY DEFINER functions pinned · no secrets in the bundle · a real restrictive CSP with HSTS · the Watchtower's source configuration, live retrieval, real Anthropic integration and citation controls · honest compliance-tier derivation that refuses self-declared text · atomic status transitions · server-authoritative pack issuance · three-gate buyer visibility · farmer role safety and tenant isolation · the public access-request funnel · 498-key Thai parity · build self-identification.

**Regression rule:** any PR that changes RLS, a grant, a policy, a SECURITY DEFINER function, a CSP header or the Watchtower citation guard must re-run the §5 evidence commands for the affected rows and paste the output in the PR. Losing a banked row costs the same as failing to win a new one, and is harder to notice.

---

## 7. OWNER-ONLY ACTIONS

These cannot be completed by an engineer or an agent. Each blocks specific rows.

| ID | Action | Blocks |
|---|---|---|
| OWNER-01 | Resolve GitHub issue #77 — the P0 gate that says all other DDP work stops until the source-backed COA Watchtower is complete. It is open since 2026-07-27 and the marketplace workstream proceeded anyway. Close it, or revoke it in writing as its own terms require. | Governance for every phase |
| OWNER-02 | Un-mark the two `VITE_*` Vercel Production vars as Sensitive (or authorise the GitHub Secrets alternative) | W0.1 — A-D1, A-D2 |
| OWNER-03 | Register `ddp-brokerage.com` defensively and approve the contact-copy change | W0.2 — B-A4 |
| OWNER-04 | Configure custom SMTP in the production Supabase project | W6.3 — F-A4, F-A5 |
| OWNER-05 | Confirm and evidence database PITR / backup position | W9.3 — A-D5 |
| OWNER-06 | Set `required_approving_review_count` above 0. Today two machine checks are the entire gate to `main`, and neither of them deploys. | Governance; compounds W0.1 |
| OWNER-07 | Confirm the pricing currency policy (THB assumed) and whether USD/EUR listings are permitted | W1.1 — F-B2 |
| OWNER-08 | Decide the commercial model behind W12 | A-C3, B-M2 |

---

## 8. STANDING VERIFICATION RULES

These are not style preferences. Each one is derived from a specific defect that reached production in this project.

1. **Never score from the repository alone.** Check the target database. A migration in the repo is not a migration in production — three are missing right now.
2. **`n_live_tup`, never `count(*)`.** `ddp_ro` is *refused* on business tables, not RLS-filtered. An empty result is an access limit, never evidence of emptiness.
3. **Read source binary-safe.** Exactly two files contain NUL bytes (`procurementControl.ts`, `DDPBuyerPreview.tsx`) and `grep`/`rg` skip them silently — and they are the buyer-gate and claims-bearing files.
4. **A green check proves only what it enumerates.** 3,001 passing tests could not catch the batch blocker because no test inserts through the client's own payload builder. Find what a check enumerates before citing it.
5. **Test through the real payload builder, against a schema-accurate database.** Mocks that never parse SQL will endorse a query against the wrong table.
6. **A failing VERIFY is reporting a real defect.** Never fix a red VERIFY by editing the VERIFY.
7. **Migrations land before the code that needs them.** CI structurally cannot catch code shipped ahead of its migration; the check must run against the target database at deploy time.
8. **An empty result never proves authorization.** Prove the negative with a positive control that would have returned rows.
9. **Work in a sibling worktree, never the shared clone** — it moves underneath you, and `git stash` is repo-wide.

---

## 9. HONEST ASSESSMENT

**Reachable.** 1000/1000 is a finite, enumerated target — 107 rows, all specified, none requiring a technology that does not exist. Nothing in the list is blocked by an unsolved problem.

**Two rows depend on facts outside the codebase.** `A-D5` (PITR) and `F-A4` (invitation delivery at volume) can only reach 100% with owner action plus recorded evidence. Both are cheap; neither is an engineering task.

**The shape of the work is lopsided.** 40 points unblock the pipeline, ~330 make a farm able to trade, and 438 are a buyer marketplace that does not exist. The first 40 points are worth more than their weight: until a merge ships, every other point in this plan is theoretical.

**The real risk is not any single defect.** It is that the database keeps running far ahead of the application — migrations of commercial machinery live in production with zero application code and zero rows, while SQL VERIFY scripts prove the schema correct and prove nothing about whether the product uses it. That is precisely the blind spot that let the batch-insert blocker ship past 3,001 passing tests. Every workstream above is specified so that its acceptance test runs through the product, not around it.

---

## 10. WORK DELIVERED SINCE PUBLICATION

Recorded separately from scoring on purpose. **Shipping is not scoring.** A row moves only when its §5 acceptance test passes and its evidence command is re-run — several items below are live in production and still carry zero points, because the test that would score them needs a session or a device this work could not obtain.

| Ref | Work | State | Rows scored |
|---|---|---|---|
| W0.1 | Authorised deploy path repaired | **Live.** 4 consecutive green deploys after 12 consecutive failures; the "verify the live site serves this exact commit" step has now executed for the first time | **0** — A-D1/A-D2 pending a scoring pass |
| W0.2 | Dead contact domain corrected | **Live.** 0 occurrences of the unregistered domain in the deployed bundle | **0** — B-A4 needs the two mailboxes proven to receive |
| W1 | Batch submission unblocked; failure reported truthfully | **Live** (`018925b`) | **0** — needs a farmer session; baseline recorded below |
| W10.3 | Thai reachable on the QR landing path | **Live, verified end to end in a real browser**: toggle present, switches, persists across reload, `<html lang="th">`, 0 console errors | **0** — handset auto-detection not verified live |
| W10.1 | Farm profile validation | PR open | 0 |
| W10.5 | Farmer-form accessibility | PR open | 0 |

**Baseline for the W1 acceptance test, recorded 2026-08-06:**

```
inventory_batches  →  n_live_tup = 1,  n_tup_ins = 59
```

Submit a priced batch as a farmer and re-run the §5 evidence command. Live rows moving 1 → 2 closes F-B2 and unlocks most of W1's 193 points. If it does not move, the fix is incomplete and that matters more than any row.

---

## 11. FINDINGS RAISED SINCE PUBLICATION

Each was measured while doing the work above, and none is fixed by it.

**F-N1 — 105 of the farm wizard's 131 fields are never collected.** `FarmerOnboarding` declares 131 fields in its draft and renders **26**. The other 105 are written to `public.farms` as empty strings on every submission. The audit's "~120 fields, zero validation" is really a 26-field form writing 131 columns. Decide which it is before building farm scoring (row **A-F2**) on top of them — a completeness percentage computed over fields nobody can fill is a number that cannot mean anything.

**F-N2 — `public.farms` has no constraints at all.** Zero CHECK constraints; three NOT NULL columns (`id`, `created_at`, `updated_at`). `inventory_batches` has nineteen. W10.1 puts a guard in the client, where anything that is not the wizard bypasses it. The durable fix is CHECKs on the table — **W5 / Lane B**, and it needs a migration number.

**F-N3 — every numeric field prompts with its unit, so numeric validation must parse leniently.** The placeholders read `e.g. 800 kg`, `e.g. 2000 kg/year`, `e.g. 0.1%`. `Number('800 kg')` is `NaN`. Any validation using `Number()` directly refuses precisely the farmers who followed the instructions — which the first draft of W10.1 did, and which its own tests caught. **Two placeholders are also simply wrong**: `harvestsPerYear` prompts `e.g. 500 kg` (a weight, for a count) and `typicalCbd` prompts `e.g. 10–12 weeks` (a duration, for a percentage).

**F-N4 — a row → item mapper that drops a column silently redenominates data.** `batchRowToInventoryItem` did not map `price_currency`, so an edited batch reached the write path with none and picked up the THB fallback: a 100 USD listing saved back as 100 THB, number untouched. Fixed in W1, but the rule generalises — **when a write path supplies a default, every read path must carry that column**, or an edit becomes a silent conversion. Worth checking the other mappers against their write paths.

**F-N5 — an unpriced batch stores `0`, not NULL.** `pricePerKg` is `parseFloat(x) || 0`, so a batch submitted with no price reads to a buyer as **฿0/kg** rather than "price on application". A truthfulness defect belonging to **W4 / B-P7**; changing it ripples into the `InventoryItem` type and the benchmark comparison.

**F-N6 — the farm draft calls `localStorage` unguarded.** `loadFarmDraft`/`saveFarmDraft` have no try/catch. Safari private mode throws on `setItem`, which would surface as a crash rather than a lost draft. Belongs with **W10.2**.

**F-N7 — `.deepsource.toml` says the JavaScript analyzer is an accepted red. That is now false.** `main` passes it. During this work the analyzer produced two genuinely useful findings — a validator that would have blocked every compliant farmer, and a test that was silently reading the host machine's language instead of asserting anything. **Treat a red as signal and delete the stale note**, or the next person will wave it through.

**F-N8 — the fix for iOS zoom already existed and had not been applied everywhere.** The `.eo-farmer` rules set `font-size: 16px` with the comment "16px keeps iOS from zooming the page on focus"; the generic `.field` used by every signed-out form stayed at 14px. Where a hazard has already been diagnosed once in this codebase, **check whether the remedy reached every surface** before treating it as new.

---

## 12. ROWS SCORED

The first rows to move, and the only ones so far. Each is here because its §5 acceptance test passed and its evidence command was re-run — not because the work shipped.

| Row | Was | Now | Evidence |
|---|---:|---:|---|
| **A-D1** Authorised deploy path works | 0 / 15 | **15** | **6 consecutive** `Deploy to Production` jobs on `main`, every one green **including** the "Verify the live site serves this exact commit" step — a step that had never executed once before 2026-08-06 |
| **A-D2** Live build has passing-CI provenance | 0 / 10 | **10** | The deploy job is gated `needs: verify`, builds from the exact merge commit, and the live `/version.json` `commitSha` equals `origin/main` on every one of those runs |

### Scored 2026-08-07 — a farmer listed a batch in production

The acceptance test in §5 W1 was run by the owner against production. Measured before and after with the §5 evidence command:

```
before   inventory_batches | n_live_tup 1 | n_tup_ins 59      (58 silent failures)
after    inventory_batches | n_live_tup 3 | n_tup_ins 61      (2 attempts, 2 rows, 0 failures)
```

Those inserts **could not have succeeded** unless the client sent `price_currency`: `inventory_batches_price_requires_currency` refuses a priced row without one. The constraint that caused the outage is what certifies the fix.

| Row | Was | Now | Basis |
|---|---:|---:|---|
| **F-B2** Batch submission succeeds | 0 / 50 | **50** | Two submissions, two rows, no failures |
| **F-R1** Submit for review | 0 / 20 | **20** | Unblocked by the same evidence |
| **F-V2** A real farm could list a batch today | 0 / 20 | **20** | A real farm did |
| **F-B1** Batch form captures required fields | 15 / 30 | **30** | The form can now fulfil its purpose |

**Farmer raw: 433 → 538.**

**A cap decision is now required, and is deliberately not being made here.** The Farmer and Admin caps of 450 rest on the stated ground that "the admin's primary lifecycle cannot complete, because its input (farmer submissions) is blocked and its output (a buyer) does not exist." **The input half is no longer true.** Whether the 450 cap still binds the Farmer persona on the remaining half alone is a scoring judgement for the owner, not something to assume in either direction:

- Cap still binding → Farmer **450**, overall **390**
- Cap lifted for Farmer → Farmer **538**, overall **416**

Recorded as an open decision. Silently choosing the flattering number is exactly the failure this plan exists to prevent.

**Still not scored from W1:** F-B3 (failure reported truthfully, 25) and F-S2 (errors surfaced, 15) — both need the other half of the acceptance test: force a database error and confirm an error state renders rather than a success screen. Untested.

**Admin raw: 540 → 565. Overall: unchanged at 385.**

That last point is the one worth understanding. The Admin persona is **capped at 450** because its primary lifecycle cannot complete, and the raw score was already above the cap — so banking 25 real points moves the headline by nothing. The cap lifts only when a farmer can submit and a buyer exists; until then, Admin work is invisible in the total no matter how much of it is done.

**Not scored, and why** — the discipline is the point:

- **F-U2 (Thai on the primary entry path)** — Thai *is* verified live in a real browser: the toggle renders on `/farmer`, switches the page, persists across a reload, and sets `<html lang="th">`, with zero console errors. But W10's §5 acceptance test asks for a Thai-speaking farmer completing onboarding **on a 375px phone** and resuming **on another device**, and neither has been done. The work is live; the row stays at 6.
- **B-A4 (contact channel)** — the dead domain is gone from the deployed bundle, but nobody has proven the two mailboxes receive. Owner action, §7.
- **All of W1 (193 points)** — the fix is live; the acceptance test needs a farmer session. Baseline stands at `n_live_tup = 1`, `n_tup_ins = 59`.

Six pieces of work are live and 25 points are banked. The distance between those two numbers is what this section exists to keep honest.

---

**Prepared 2026-08-06; §10–§11 added 2026-08-06 after the first delivery pass.** Every factual claim carries the command that produced it (§3). Ledger arithmetic is computed and asserted, not hand-totalled (§2). Amend only under the rule in §0.

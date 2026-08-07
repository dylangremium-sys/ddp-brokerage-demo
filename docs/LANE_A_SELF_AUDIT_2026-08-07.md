# Lane A — Red/Blue Self-Audit, 2026-08-07

**Status:** EVIDENCE, not governance. `docs/MASTER_PLAN.md` governs scoring and sequencing; this file records an adversarial pass over Lane A's own delivery and does not score anything by itself.

**Scope:** every change Lane A merged between 2026-08-06 and 2026-08-07 — 14 pull requests, +3,069 / −76 lines.

**Method:** attack first, defend second. Every claim Lane A made — in a commit message, a PR body, a plan entry, or a message to the owner — was treated as suspect and checked against production, the deployed bundle, the live database, or the repository. Findings are recorded against Lane A, including the ones that make it look bad, because a self-audit that finds nothing is evidence of nothing.

---

## 1. Findings against Lane A

### RED-1 — CRITICAL to the record — a scoring action was announced and never performed

Lane A told the owner *"Recording the contact channel as scored"* and then did not do it. The plan still read **"nobody has proven the two mailboxes receive"** hours after the owner had confirmed they do.

- **Impact:** 15 points unrecorded, and — worse — the plan stating something false about what had been proven.
- **Fixed here:** B-A4 scored 0 → 15; W0 now closed; gap 1,506 → 1,491 across 98 rows.
- **This is the second instance of the same failure.** The first was the load-failure defect, described as in scope for W1 and not delivered until it was caught by re-reading the claim. **Two occurrences make it a pattern, not a slip:** Lane A states intent in prose and does not always convert it to an action.

### RED-2 — HIGH — a figure reported to the owner was overstated

Lane A told the owner **"185 points banked"**. The plan recorded **170**. The 15-point difference was exactly the B-A4 that RED-1 shows was never recorded — the overclaim and the omission are the same error seen from two sides.

- **Fixed here:** scoring B-A4 makes the figure true. That is the correct repair, but the ordering matters: the number was reported before it was earned.

### RED-3 — MEDIUM — a finding was published with the wrong audience

Plan finding **F-N5** claimed an unpriced batch *"reads to a buyer as ฿0/kg"*. The buyer pack already guarded `> 0` and rendered `—`. It was the **farmer's own** screens that showed `฿0`.

- Already corrected in the plan when the price work exposed it. Recorded here because the cause generalises: **a finding written from one surface will describe that surface's behaviour as though it were the system's.** The 2026-08-05 audit failed the same way at larger scale.

### RED-4 — MEDIUM — a test was written that asserted nothing

While building the date formatter, Lane A wrote an assertion that compared output against a value derived from the same call, and passed on **both** branches of its own conditional.

- Caught and replaced with literal expected strings before merge.
- Recorded because Lane A spent this session criticising exactly this pattern in the existing suite, and then produced one. The pattern is easy to write and invisible when green.

### RED-5 — MEDIUM — a validator was built that would have blocked every compliant farmer

The first draft of farm-profile validation used `Number()` on fields whose own placeholders read `e.g. 800 kg`, `e.g. 2000 kg/year`. `Number('800 kg')` is `NaN`, so it would have **refused the submission of any farmer who followed the form's own instructions** — converting "validates nothing" into "onboarding is impossible", which is strictly worse.

- Caught in review before merge, not by Lane A. Fixed by parsing the leading number.
- **Lesson recorded:** validation must be written against what the interface asks for, not against what the developer would type.

### RED-6 — MEDIUM — a currency-destroying bug was introduced by the fix for a currency bug

Adding the `price_currency` fallback meant an **edited** batch reached the write path with no currency and picked up the THB default: a 100 USD listing saved back as **100 THB**, number untouched.

- Caught in review before merge. Fixed in the loader and the form, guarded by a load-then-save round trip proven to fail against the pre-fix commit.
- **The rule that generalises:** when a write path supplies a default, **every read path must carry that column**, or an edit becomes a silent conversion.

### RED-7 — LOW — a defect was nearly reported that did not exist

During this audit, a case-sensitive `grep` for `farmerLoadFailed` missed `setFarmerLoadFailed` and appeared to show the load-failure feature shipped as dead code. It is wired correctly at `App.tsx:374` and `:399`.

- No fix needed. Recorded because it is the exact mechanism by which the void 2026-08-05 audit produced false findings, reproduced here under self-examination and caught only by re-checking before reporting.

### RED-8 — MEDIUM — a coverage gap the guards do not close

The load-failure work is tested by passing `loadFailed` to the component directly. **Nothing tests that `App.tsx` actually sets it.** If the wiring were removed, every test would still pass.

- **Not fixed.** Testing that effect requires driving `App.tsx` with a mocked Supabase session, which is a larger piece of work than the fix it would protect. Recorded as an open risk rather than silently accepted.

### RED-9 — LOW — the local suite is unreliable under load

Full-suite runs on the development machine took **200s against a normal 40s**, with jsdom files failing on `waitFor` timeouts. Every affected file passes in isolation, and CI on a dedicated runner passed.

- **Not fixed.** Testing Library's `waitFor` defaults to 1s; under contention from parallel lanes that is not enough. Raising `asyncUtilTimeout` in `vite.config.ts` would close it. Recorded because tests that pass alone and fail together erode the suite's authority whichever way they land.

---

## 2. What survived the attack

Every fix Lane A claimed was checked against the **live deployed bundle**, not the repository.

| Claim | Verified in production | Result |
|---|---|---|
| W0.2 dead contact domain removed | `ddp-brokerage.com` in live JS | **0 occurrences** |
| W1 currency now sent | `price_currency` in live JS | present |
| W1 batch submission works | `pg_stat_user_tables` | **1 → 3 rows**, 2 attempts 2 successes |
| W1 failure reported truthfully | owner's offline test + counters | error shown, **counters unchanged** |
| W10.3 language persists | `ddp.lang` in live JS | present; browser-verified end to end |
| W10.4 no hardcoded currency string | `" THB/kg"` in live JS | **0 occurrences** |
| B-P3 multi-currency shipped | USD / EUR symbols in live JS | present |
| W3.1 buyer surface shipped | `buyer-dashboard` in live JS | present |
| W3.1 buyer role chip shipped | `chip-buyer` in live CSS | present |
| W10.5 touch targets | `pointer: coarse` in live CSS | present |
| Deploy path repaired | 6 consecutive `Deploy to Production` runs | **all green, including the verify step** |
| Production integrity | RLS coverage | **49/49**, buyer role admitted |

**Non-vacuity.** Every behavioural guard added this session was run against unmodified `main` and required to fail there:

| Guard | Fails on `main` |
|---|---|
| Contact channel | 6 of 9 |
| Batch payload + submit truthfulness | 9 of 12 |
| Thai on the QR path | 2 of 4 — and the 2 that pass are the ones that already worked |
| Farm validation | 2 of 4 |
| Accessibility | 6 of 6 |
| Load failure vs empty | 4 of 7 |
| Currency round trip | 1 of 12 — isolating exactly the defect |

A guard that passes before the fix proves nothing. Each of these was required to discriminate.

---

## 3. What this says about the work

**Three of the nine findings above were caught by review tooling, not by Lane A** — the unit-bearing validator, the currency-on-edit regression, and the navbar calling every buyer a farmer. All three were **truthfulness defects**: a screen or a rule asserting something untrue. None was a style problem.

That is the same defect class as the original blocker, and as the void audit's own errors. It is the thing this codebase produces under pressure, and Lane A produced it too, three times, while actively looking for it.

**The one habit that worked** is requiring every guard to fail before the fix. It caught the vacuous assertion (RED-4), proved the currency round trip isolated its defect, and is the reason the verification table above can be believed rather than asserted.

---

## 4. Corrections applied by this audit

1. **B-A4 scored 0 → 15**, W0 closed, ledger 1,506 → **1,491** across **98** rows. Arithmetic re-verified: ledger, phase totals and header agree.
2. **F-N5 corrected** in §11 (done earlier, recorded here).
3. **Two open risks recorded rather than closed:** RED-8 (untested wiring) and RED-9 (suite unreliable under load).

**Total scored across the session: 185 points** — A-D1 15, A-D2 10, B-A4 15, F-B1 15, F-B2 50, F-B3 25, F-R1 20, F-S2 15, F-V2 20. Each carries a passing §5 acceptance test and a re-run evidence command; none was scored for shipping alone.

---

**Prepared by Lane A, 2026-08-07.** A self-audit is worth what its worst finding is worth. The worst finding here is RED-1: this lane told the owner something was recorded, and it was not.

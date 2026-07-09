# Buyer Pack Phase A — Manual Smoke Test

**Status:** Documentation only. Running this checklist changes no code, SQL, env, or server data — Phase A persists only to the tester's browser `localStorage`.

## 1. Purpose

Verify, by hand in a real browser, that the Buyer Pack Phase A wiring works end
to end in production: an admin can issue an immutable (hashed, versioned)
snapshot of a Buyer Pack **only after** the batch is human-approved, that
re-issuing supersedes the prior version, and that the existing copy/print export
actions still work. This complements the automated unit tests
(`src/lib/buyerPackWiring.test.ts`) — the tests prove the logic; this checklist
proves the live DOM, disabled states, and browser console.

## 2. Preconditions

- The commit implementing Phase A (`ad0ac61` "Wire buyer pack snapshot
  issuance") is the deployed production build. Confirm via `/version.json`
  (see step in §5) — `commitShaShort` should be `ad0ac61` or later.
- At least one inventory batch exists with `status = Approved` and **no
  unresolved blocking issues** (no rejected/expired required documents and no
  `blocker`-severity unresolved risks), so it can reach the human-approved
  state.
- A `ddp_admin` account is available to log in with.

## 3. Test environment

- **Production URL:** https://ddp-brokerage-demo.vercel.app
- Any modern desktop browser (Chrome/Edge/Firefox/Safari) with DevTools.
- Run in a normal (non-incognito) window, or accept that closing an incognito
  window clears the `localStorage` records this test creates.
- Because Phase A snapshots/audit/downloads are stored in `localStorage`, this
  test only affects the tester's own browser — no other user or server state is
  touched.

## 4. Login role required

**`ddp_admin`.** The Buyer Preview / Buyer Pack pages are admin-only; a farmer
account cannot reach them. There is no separate buyer login in Phase A — the
admin previews the pack a buyer would receive.

## 5. Step-by-step manual test

1. **Confirm the deployed build.** Open
   `https://ddp-brokerage-demo.vercel.app/version.json` and note
   `commitShaShort` (expected `ad0ac61` or later).
2. **Log in** as a `ddp_admin`, then open DevTools → Console and keep it visible
   for the whole run.
3. Navigate to **Supply Ledger → Master Inventory**.
4. On an `Approved` batch, click **Generate Buyer Pack** (a.k.a. "Initiate
   Procurement Sequence") to open the single-batch Buyer Pack.
5. Scroll to the **Immutable Buyer Pack Record** section. Confirm the **Issue
   Buyer Pack** button is **disabled** and the helper text "Enabled only after
   this batch is human-approved for buyer discussion." is shown.
6. In **Recommended Decision**, select **Progress**, then click **Record
   Decision**. Confirm "✓ Saved" appears.
7. **Reload the Buyer Pack** (re-open it from Master Inventory, or refresh).
   Confirm the human-approved state now shows (verified-supply seal + approved
   badge) and the **Issue Buyer Pack** button is now **enabled**.
8. Click **Issue Buyer Pack**. Confirm a success notice ("Buyer pack v1
   issued.") and that the record panel now shows **Snapshot Version v1**, a
   truncated **Content Hash** (12 hex chars + "…"), and **Status: generated**.
9. Click **Copy Summary** — confirm it still copies (button shows "✓ Copied").
10. Click **Print / Save PDF** — confirm the browser print dialog still opens.
11. Click **Re-Issue Buyer Pack (new version)**. Confirm the notice now reads
    "Buyer pack v2 issued." and the panel shows **Snapshot Version v2** with
    **Status: generated**.
12. (Optional) Inspect `localStorage` per §8 to confirm v1 is preserved and
    marked superseded, and that audit/download records exist.

## 6. Expected results

- Before a recorded Progress decision: **Issue Buyer Pack is disabled.**
- After Progress is recorded and the pack is reloaded: **Issue Buyer Pack is
  enabled.**
- First issue: **version 1**, a 64-hex content hash (shown truncated), status
  **generated**.
- Copy and Print actions behave exactly as before Phase A.
- Re-issue: **version 2**, status **generated**; **version 1 is preserved** and
  becomes **superseded** (visible via §8).
- No uncaught errors in the console at any step.

## 7. Browser console checks

- No red uncaught exceptions or unhandled promise rejections during any step
  (especially on **Issue** / **Re-Issue**).
- No Content Security Policy or network errors introduced by the pack actions
  (Phase A makes **no** network/Supabase/AI calls — issuing is local only).
- If Supabase is configured for the environment, opening the COA still uses a
  signed URL as before; the snapshot flow itself should generate **no** network
  requests.

## 8. localStorage keys to inspect

In DevTools → Application/Storage → Local Storage → the site origin:

| Key | Holds | What to confirm |
|---|---|---|
| `ddp_buyer_pack_snapshots` | Snapshots keyed by pack (batch) id | After re-issue, the batch has **two** entries, versions 1 and 2; version 1 is unchanged (append-only, not overwritten). |
| `ddp_buyer_pack_audit_trail` | Audit events per pack | Contains `pack_generated` for v1 and v2, plus `pack_superseded` for v1 after re-issue. |
| `ddp_buyer_pack_download_history` | Download records per pack | Contains an entry with `format: "summary-copy"` after Copy, and `format: "print-pdf"` after Print (only recorded once a snapshot exists). |
| `ddp_procurement_decisions` | Recorded procurement decisions | The tested batch shows `decision: "progress"`. |

(Each snapshot's `manifest.contentHash` should match the truncated value shown
in the UI; the same evidence re-issued produces the **same** hash across
versions, since the hash excludes version/bookkeeping fields.)

## 9. Known limitation

Phase A persistence is **`localStorage` only**. This makes an issued Buyer Pack
snapshot **tamper-evident** — the content hash detects any change to the
captured evidence — but it is **not durable, server-side immutability**:

- Records live only in the browser that issued them; they are not shared across
  devices/users and are lost if the tester clears site data.
- A user with access to their own browser storage can delete or edit these
  entries; `localStorage` cannot enforce append-only storage the way a server
  can.
- Durable, tamper-**resistant** persistence (a Supabase-backed repository with a
  server-enforced append-only guarantee, mirroring the Compliance Watchtower
  `compliance_audit_log` trigger) is **Phase B** — out of scope here and not yet
  implemented.

Do not describe Phase A as providing durable or tamper-proof evidence in any
buyer-facing or external material.

## 10. Pass / fail table

| # | Check | Pass / Fail | Notes |
|---|---|---|---|
| 1 | `/version.json` shows `ad0ac61` (or later) | | |
| 2 | Admin can open Buyer Preview / Buyer Pack | | |
| 3 | Issue Buyer Pack **disabled** before approval | | |
| 4 | Recording **Progress** enables Issue (after reload) | | |
| 5 | Issuing creates **version 1** | | |
| 6 | Snapshot **content hash** displays (truncated) | | |
| 7 | Status shows **generated** for the latest version | | |
| 8 | **Copy Summary** still works | | |
| 9 | **Print / Save PDF** still works | | |
| 10 | Re-issue creates **version 2** | | |
| 11 | Version 1 **preserved** and marked **superseded** | | |
| 12 | Audit events present (`pack_generated` ×2, `pack_superseded` ×1) | | |
| 13 | Download records present (`summary-copy`, `print-pdf`) | | |
| 14 | **No console errors** throughout | | |

**Overall result:** ☐ Pass ☐ Fail

**Tester:** ______________  **Date:** ______________  **Build (`commitShaShort`):** ______________

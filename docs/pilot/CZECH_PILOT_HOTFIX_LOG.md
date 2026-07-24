# Czech Pilot — Hotfix Log

Append one entry per hotfix. Newest first. Scope = the 4 pilot flows only.
All branches below are **local, not pushed** (per ratified autonomy decision: local-only, no PR until authorized).

---

## HF-003 — Compliance status action shows success on failed write
- **Timestamp:** 2026-07-24
- **Severity:** P1
- **Flow impacted:** 3 (compliance review/status) + 1 (farm submit)
- **Root cause:** `handleFarmSubmit`, `handleFarmAction`, `handleInventoryAction` in `src/App.tsx` updated React state optimistically, fired the Supabase write with `.catch(onDbError)` **without awaiting**, then navigated unconditionally. A failed write left the UI showing success ("Submitted to DDP"; a batch shown Approved, which unlocks buyer-visibility) until a reload silently reverted it.
- **Fix summary:** Await the write in try/catch; snapshot state and roll back the optimistic change + stay on-screen on failure; navigate only on success. Mirrors the already-correct `handleInventorySubmit`. No schema/API change.
- **Branch / commit:** `hotfix/await-optimistic-writes` @ `7801db8`
- **PR link:** _not opened (local-only)_
- **Validation evidence:** `tsc -b` clean; `npm test` 1740/1740 pass. Behavioural coverage via smoke C1.1 / C3.1 / C3.3 (pending staging app).
- **Residual risk:** No automated component-render test for the async rollback (App.tsx not unit-harnessed); relies on manual smoke. Low.
- **Decision:** **SHIP** (pending your merge authorization).

## HF-002 — (folded into HF-003) farm-submit fire-and-forget
- Covered by HF-003 (`handleFarmSubmit`). Same branch/commit.

## HF-001 — Scalar `photo_url` persists multi-MB data: URL
- **Timestamp:** 2026-07-24
- **Severity:** P1 (P0 for the affected farmer submission)
- **Flow impacted:** 2 (evidence upload)
- **Root cause:** `createInventoryBatch` (`src/lib/db.ts`) stripped `data:` URLs from the `photo_urls` array but wrote the scalar `photo_url` column unfiltered. A mobile camera capture is a multi-MB base64 blob that bloats the row and can exceed the API body limit, failing the whole batch insert.
- **Fix summary:** Mirror the array filter for the scalar: persist only an already-hosted (http/https) URL, else null. One-line logic + regression test.
- **Branch / commit:** `hotfix/coa-photo-dataurl-filter` @ `628f531`
- **PR link:** _not opened (local-only)_
- **Validation evidence:** New `src/lib/db.photoUrl.test.ts` (2/2 pass) driving the real db.ts upsert; full suite 1740/1740; `ci:verify` green.
- **Residual risk:** Photos are still not uploaded to Storage (product-photo signed storage remains a documented follow-up); this only stops the row-bloat/insert-failure bleed. Low.
- **Decision:** **SHIP** (pending your merge authorization).

---

### Not executed this pass (deferred)
- **BP-LIST-SEAL (P1→defer):** Buyer-preview *list* renders "Human-Approved" seal from the localStorage decision cache while the exportable single pack is server-authoritative. **Export gate does NOT leak** (Print/Copy/Issue are server-authoritative + print-CSS fail-closed) — this is a display-only mislead on an internal screen. `DDPBuyerPreview.tsx:843-845`. Est 30 min. Deferred to keep the launch batch tight; schedule for Phase 2.

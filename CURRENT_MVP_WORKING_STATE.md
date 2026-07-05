# Current MVP Working State

**Date:** 30 June 2026
**Branch:** `auth-rls-mvp` (aligned with `main`)
**Commit:** `497cb09` — DOCS: record Buyer Pack MVP validation
**Live URL:** https://ddp-brokerage-demo.onrender.com

---

## Confirmed Working Features

### Farmer Portal
- Farmer can submit new stock (Add Stock form)
- Farmer can edit existing stock submissions
- Product photo upload works (captured as data URL in demo mode)
- COA file upload works (stored to Supabase Storage private bucket `farmer-documents` in live mode)
- Water activity field saved correctly
- Storage conditions field saved correctly
- Farmer notes saved correctly
- Stock linked to farm by `farm_id` (farm-linkage fix applied)

### Admin — Inventory Review
- Admin can view submitted batches
- Admin can approve, reject, or flag batches as Missing Document
- Status history is recorded on each status change
- Approve batch promotes it to Master Inventory

### Admin — Master Inventory
- Approved batches appear with correct data
- Stats row: batch count, total kg, farms with approved stock
- COA View button opens signed Supabase Storage URL (live mode)
- Export column visible with 📋 Buyer Pack button per approved row

### Buyer Pack
- Opens from Master Inventory per approved batch
- Header: product name, farm, batch number, DDP Approved badge, DDP Reviewed Supply Seal
- Farm & Origin section: farm name, province, partner tier
- Availability & Pricing section: quantity, price per kg, minimum order, unit
- Lab Values: THC %, CBD %, moisture %, water activity
- Storage & Grade: storage conditions, quality grade, stock status
- Documents section: COA listed with Open button (signed URL, live mode); photo listed
- Product photo preview renders inline
- Open Photo: opens image in new tab (data URL → blob URL conversion for demo mode)
- Copy Summary: copies plain-text buyer summary to clipboard
- Print / Save PDF: triggers browser print dialog with non-print elements hidden
- Compliance checklist: evidence-controlled, 11-item review (checklist now separates COA claimed by farm from COA file received); pass count for the validated demo batch (FARM-LINK-001) not re-verified against the current 11-item checklist
- Back button returns to Master Inventory

### Branding
- DDP Monogram Logo in navbar
- DDP Hero Wordmark on landing page
- DDP Reviewed Supply Seal in Master Inventory banner and Buyer Pack header

---

## Validated Demo Batch

| Field | Value |
|---|---|
| Product | Farm Link Test |
| Batch | FARM-LINK-001 |
| Farm | Demo Farm |
| Location | Chiang Mai, Thailand |
| Status | Approved |
| Quantity | 29 kg |
| Compliance | 11-item checklist |

**Master Inventory totals at time of validation:** 3 approved batches · 89 kg · 1 farm with approved stock

---

## Known Remaining Issues / Non-Blocking Limitations

- **Render API key expired** — programmatic deploys are unavailable; all deploys require manual trigger from Render Dashboard
- **COA extraction is manual** — COA data (lab name, THC, CBD, etc.) must be entered by the farmer; no AI extraction
- **Buyer Preview prototype** — the Buyer Preview page shows a placeholder dashboard unless accessed via Buyer Pack button from Master Inventory
- **Old test batches** — some earlier test submissions remain in the database outside the clean demo batch
- **`RESET_*.sql` stubs** — three untracked SQL reset files remain locally (intentional, not committed)
- **`photo_url` not filtered on save** — `db.ts` filters data: URLs from `photo_urls` array but not from the scalar `photo_url` field; photos only work cleanly in demo mode or when stored as HTTPS URLs

---

## Recommended Next Phase

1. **Buyer registration / interest flow** — allow a buyer to submit interest against a specific Buyer Pack batch; route notification to DDP admin
2. **COA AI extraction** — parse uploaded COA PDFs to auto-fill lab values (THC, CBD, moisture, water activity, lab name, test date)
3. **Signed photo storage** — move product photo upload to Supabase Storage (parallel to COA upload) so photos are accessible via signed URLs in live mode
4. **Render credential refresh** — re-authenticate Render CLI so programmatic deploys are restored
5. **Buyer-facing portal** — separate buyer login role with read-only access to approved batches and their Buyer Packs

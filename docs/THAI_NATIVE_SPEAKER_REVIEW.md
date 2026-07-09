# Thai Native-Speaker Review — Public Copy Wording

This file tracks Thai-language public copy that was machine-downgraded from
"verified/checked" framing to "reviewed/onboarded" framing (to match an
English-language safety pass removing unsupported verification/certification
claims), and needs a native Thai speaker to confirm the replacement reads
naturally and doesn't reintroduce a stronger claim than the English source.

Source file for all entries: `src/translations.ts` (Thai (`th`) section of
the `T` object).

None of these are blocking issues — the current Thai strings are believed
safe (no stronger than the English), but have not been confirmed by a native
speaker.

---

## Already changed — needs confirmation the replacement reads naturally

| Key | Line | English | Old Thai | New Thai (current, needs review) |
|---|---|---|---|---|
| `landingFrameworkVerifiedLabel` | 528 | Reviewed | ตรวจสอบแล้ว (checked/verified) | ตรวจทานแล้ว (reviewed) |
| `landingFrameworkVerifiedDesc` | 529 | Batch reviewed | ตรวจสอบแบทช์แล้ว | ตรวจทานแบทช์แล้ว |
| `landingWhy1Title` | 550 | Reviewed Supply | (n/a — title itself downgraded) | อุปทานที่ตรวจทานแล้ว |
| `landingOrgItem1Desc` | 564 | Documented grower details | (n/a — downgraded to "documented") | ข้อมูลผู้ปลูกที่มีการบันทึกไว้ |
| `landingDisclaimer` | 588 | "...Access is limited to onboarded partners..." | พันธมิตรที่ผ่านการตรวจสอบ (partners who have passed verification/inspection) | พันธมิตรที่เข้าร่วมโครงการ (partners who have joined/onboarded) |
| `landingWhy4Desc` | 566 | ...ready to progress. | ...พร้อมซื้อ (ready to buy) | ...พร้อมดำเนินการต่อ (ready to progress) |

`landingTagline` and `landingNavDescriptor` were removed from this table —
see "Resolved" section below; they were further reworded and confirmed by a
later, separate review.

## New strings added in the Wave 1 professionalisation pass — not yet reviewed

These are brand-new public-facing strings (no prior English/Thai pair to
compare against), added alongside `docs/PROFESSIONALIZATION_ROADMAP.md`.
Flagged the same way as any other new Thai copy — needs a native speaker to
confirm natural phrasing before being treated as final.

| Key | Line | English | Thai (needs review) |
|---|---|---|---|
| `landingAccessBuyerCta` | 513 | Buyer or procurement partner? Contact DDP | เป็นผู้ซื้อหรือพันธมิตรด้านจัดซื้อ? ติดต่อ DDP |
| `landingHeroMockCaption` | 518 | Illustrative example — not a live batch. | ตัวอย่างประกอบ — ไม่ใช่แบทช์จริง |
| `landingAuthorityNote` | 590 | DDP organizes, consolidates, and reviews supplier documentation. DDP does not certify export readiness, pharmaceutical readiness, or legal compliance in any jurisdiction. Buyer decisions should rely only on reviewed documents and confirmation from a qualified party. | DDP จัดระเบียบ รวบรวม และตรวจทานเอกสารของซัพพลายเออร์ DDP ไม่รับรองความพร้อมด้านการส่งออก ความพร้อมด้านเภสัชกรรม หรือความถูกต้องตามกฎหมายในเขตอำนาจใดๆ การตัดสินใจของผู้ซื้อควรอ้างอิงจากเอกสารที่ตรวจทานแล้วและการยืนยันจากผู้ที่มีคุณสมบัติเท่านั้น |
| `landingBuyerPackDesc` | 549 | A clear summary of farm and batch status for every DDP-reviewed batch. (reworded from "approved batch" per audit remediation — see PROFESSIONALIZATION_ROADMAP.md) | สรุปสถานะฟาร์มและแบทช์อย่างชัดเจน สำหรับทุกแบทช์ที่ DDP ตรวจสอบแล้ว |

This last one (`landingAuthorityNote`) is the most important of the three to
get right — it's the platform's explicit non-overclaiming statement. A
mistranslation that reintroduces a stronger claim (e.g. rendering "does not
certify" as something softer) would defeat the entire point of adding it.

## Not yet changed — flagged in prior audit, still open (should-fix-next)

These two strings still use ตรวจสอบ (checked/verified) where the parallel
English copy already reads "reviewed"/"ready for review." They were
deliberately **not edited** by the last hardening pass (kept out of scope
per "do not edit translations.ts" for this task) and are left here as the
next actionable item.

| Key | Line | English | Current Thai | Suggested replacement |
|---|---|---|---|---|
| `landingWhy3Desc` | 563 | Only reviewed batches reach the Buyer Pack. | เฉพาะแบทช์ที่ตรวจสอบแล้วเข้าสู่ Buyer Pack | เฉพาะแบทช์ที่ตรวจทานแล้วเข้าสู่ Buyer Pack |
| `landingOrgItem2Desc` | 575 | Stock ready for review | สต็อกที่พร้อมตรวจสอบ | สต็อกที่พร้อมตรวจทาน |

## Reviewed and judged safe as-is (no action needed)

| Key | Line | English | Thai | Why it's fine |
|---|---|---|---|---|
| `landingWhy1Desc` | 559 | Checked against documents and COA before listing. | ตรวจสอบกับเอกสารและ COA ก่อนขึ้นบัญชี | English itself says "Checked," so ตรวจสอบ (checked) matches — not an overclaim, no mismatch with the softened "reviewed" framing used elsewhere. |

## Resolved — see docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md

`landingTagline` and `landingNavDescriptor` (both listed above under
"Already changed" in earlier revisions of this file) were reworded a second
time as part of a separate "Buyer-Ready" → "Buyer Discussion" softening
pass, and their new Thai wording was reviewed and approved by a Thai/legal
reviewer — see `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md` for the full
phrase-pair list and sign-off. That pass also covered `landingHeadline`,
`landingFrameworkBuyerReadyLabel`, `landingWhy3Title`, `landingOrgDesc`,
`landingAboutText1`, and `StatusBadge.tsx`'s `'buyer-ready'` label — none of
which were ever tracked as rows in this file, so there is nothing further
to remove here for those keys.

Applied in commit `9bc43090e5212c670e553c2d57a4810b91c7466e` (wording) and
commit `04c1c03158bcf601afbfefbfd6043178756f8c8f` (removal of the
now-resolved `// NOTE: ... needs native speaker review` comments in
`src/translations.ts` and `src/components/shared/StatusBadge.tsx`).

---

## How to action this

1. Have a native Thai speaker read each "New Thai" value above in context on
   the live landing page (check the project's Vercel dashboard for the
   current production URL; EN/TH toggle in the top nav).
2. Confirm ตรวจทาน ("reviewed"/"looked over") reads as a softer, more
   accurate claim than ตรวจสอบ ("checked"/"verified"/"inspected") in each
   context — i.e. it doesn't imply DDP has independently certified or
   guaranteed the underlying data.
3. For the two "not yet changed" rows, apply the suggested replacement in
   `src/translations.ts` once confirmed (or supply a better native phrasing).
4. Once confirmed, remove the corresponding `// NOTE: ... needs native
   speaker review` comments in `src/translations.ts` and delete the matching
   rows from this file (or mark them done).

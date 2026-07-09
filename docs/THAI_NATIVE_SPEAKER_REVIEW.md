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

All rows formerly listed in this section (`landingFrameworkVerifiedLabel`,
`landingFrameworkVerifiedDesc`, `landingWhy1Title`, `landingOrgItem1Desc`,
`landingDisclaimer`, `landingWhy4Desc`, `landingTagline`,
`landingNavDescriptor`) are now resolved — see the "Resolved" sections
below for sign-off references.

## New strings added in the Wave 1 professionalisation pass — not yet reviewed

These are brand-new public-facing strings (no prior English/Thai pair to
compare against), added alongside `docs/PROFESSIONALIZATION_ROADMAP.md`.
Flagged the same way as any other new Thai copy — needs a native speaker to
confirm natural phrasing before being treated as final.

| Key | Line | English | Thai (needs review) |
|---|---|---|---|
| `landingAccessBuyerCta` | 513 | Buyer or procurement partner? Contact DDP | เป็นผู้ซื้อหรือพันธมิตรด้านจัดซื้อ? ติดต่อ DDP |
| `landingHeroMockCaption` | 518 | Illustrative example — not a live batch. | ตัวอย่างประกอบ — ไม่ใช่แบทช์จริง |

`landingAuthorityNote` and `landingBuyerPackDesc` (formerly listed here)
are now resolved — see the "Resolved" section below.

## Not yet changed — flagged in prior audit, still open (should-fix-next)

Both strings formerly listed here (`landingWhy3Desc`, `landingOrgItem2Desc`)
have been changed to their suggested replacement and are now resolved —
see the "Resolved" section below.

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

## Resolved — verified→reviewed terminology (reviewer-approved)

The following 10 items — covering every remaining open "verified/checked →
reviewed" and related overclaim-risk item from the sections above — were
reviewed and approved by a native Thai speaker:

| Key | Resolution |
|---|---|
| `landingFrameworkVerifiedLabel` | Confirmed as-is: ตรวจทานแล้ว |
| `landingFrameworkVerifiedDesc` | Confirmed as-is: ตรวจทานแบทช์แล้ว |
| `landingWhy1Title` | Confirmed as-is: อุปทานที่ตรวจทานแล้ว |
| `landingOrgItem1Desc` | Confirmed as-is: ข้อมูลผู้ปลูกที่มีการบันทึกไว้ |
| `landingDisclaimer` | Confirmed as-is: พันธมิตรที่เข้าร่วมโครงการ |
| `landingWhy4Desc` | Confirmed as-is: ...พร้อมดำเนินการต่อ |
| `landingAuthorityNote` | Confirmed as-is (including ไม่รับรอง for "does not certify") |
| `landingBuyerPackDesc` | Changed: ตรวจสอบแล้ว → ตรวจทานแล้ว, to match the already-safe English ("DDP-reviewed") and stay consistent with `landingFrameworkVerifiedLabel` elsewhere in this file |
| `landingWhy3Desc` | Changed to the previously-suggested replacement: ตรวจสอบแล้ว → ตรวจทานแล้ว |
| `landingOrgItem2Desc` | Changed to the previously-suggested replacement: พร้อมตรวจสอบ → พร้อมตรวจทาน |

English text was not changed for any of these — only Thai. The
corresponding `// NOTE: ... needs native speaker review` comments in
`src/translations.ts` have been removed for all of the above.

`landingAccessBuyerCta` and `landingHeroMockCaption` (see "New strings"
section above) remain open — they contain no verified/reviewed/overclaim
content and were out of scope for this review.

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

# Review Note — "Buyer Discussion" Wording (Thai + Legal)

**Status:** Pending. Source files (`src/translations.ts`,
`src/components/shared/StatusBadge.tsx`) are uncommitted on purpose and will
stay uncommitted until this is resolved.

## Why this note exists

These strings replace earlier "Buyer-Ready" / "Buyer-Readiness" wording,
which read too easily as a claim that the goods themselves were
purchase-ready or certified. The English was reworded to describe DDP's
actual function — preparing a review pack so a buyer *conversation* can
happen — not a claim about the goods, the farm, or the batch.

**Intended meaning of every phrase below: "ready for discussion only" —
not approved, not certified, not compliant, not export-ready, not
verified/confirmed (not a verified supplier or verified batch), and not
"ready to buy."**

Please confirm each Thai phrase carries only that narrow meaning, or
suggest safer wording if it risks reading as any of the excluded claims
above.

## Phrase pairs to review

| # | File | Key | English | Thai |
|---|---|---|---|---|
| 1 | `translations.ts` | `landingTagline` | Buyer Discussion Platform for Licensed Cannabis Supply | แพลตฟอร์มสำหรับการหารือกับผู้ซื้อ สำหรับอุปทานกัญชาที่ได้รับใบอนุญาต |
| 2 | `translations.ts` | `landingNavDescriptor` | Buyer Discussion Platform | แพลตฟอร์มหารือกับผู้ซื้อ |
| 3 | `translations.ts` | `landingHeadline` | Thai Cannabis Supply, Ready for Buyer Discussion | อุปทานกัญชาไทย พร้อมสำหรับการหารือกับผู้ซื้อ |
| 4 | `translations.ts` | `landingFrameworkBuyerReadyLabel` | Ready For Buyer Discussion | พร้อมสำหรับการหารือกับผู้ซื้อ |
| 5 | `StatusBadge.tsx` | `'buyer-ready'` status label | Ready For Buyer Discussion | พร้อมสำหรับการหารือกับผู้ซื้อ |
| 6 | `translations.ts` | `landingWhy3Title` | Batches Ready For Buyer Discussion | แบทช์พร้อมหารือกับผู้ซื้อ |
| 7 | `translations.ts` | `landingOrgDesc` | The building blocks behind every batch ready for buyer discussion. | ส่วนประกอบเบื้องหลังทุกแบทช์ที่พร้อมหารือกับผู้ซื้อ |
| 8 | `translations.ts` | `landingAboutText1` (fragment) | ...into a clear **buyer-discussion review pack**... | ...ให้เป็น**แพ็กข้อมูลสำหรับการหารือกับผู้ซื้อ**ที่ชัดเจน... |

## One thing to flag explicitly

Rows 4–5 use the longer construction **พร้อมสำหรับการหารือกับผู้ซื้อ**
("ready for the discussion with buyer"), while rows 6–7 use the shorter
**พร้อมหารือกับผู้ซื้อ** ("ready [to] discuss with buyer"). Both are meant
to express the same "discussion only" idea, in different sentence
positions. Please confirm both readings are equally safe (neither implies
more certainty/readiness than the other), or recommend unifying on one
form.

## Request

For each row: confirm the Thai reads as "ready for discussion only" and
does **not** imply approval, certification, legal/regulatory compliance,
export readiness, verification/confirmation (i.e. does not read as a
verified supplier or verified batch), or that the batch is ready to
purchase — or propose safer replacement wording if it does.

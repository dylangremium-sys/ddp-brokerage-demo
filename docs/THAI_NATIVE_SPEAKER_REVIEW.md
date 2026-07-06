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
| `landingDisclaimer` | 579 | "...Access is limited to onboarded partners..." | พันธมิตรที่ผ่านการตรวจสอบ (partners who have passed verification/inspection) | พันธมิตรที่เข้าร่วมโครงการ (partners who have joined/onboarded) |

## Not yet changed — flagged in prior audit, still open (should-fix-next)

These two strings still use ตรวจสอบ (checked/verified) where the parallel
English copy already reads "reviewed"/"ready for review." They were
deliberately **not edited** by the last hardening pass (kept out of scope
per "do not edit translations.ts" for this task) and are left here as the
next actionable item.

| Key | Line | English | Current Thai | Suggested replacement |
|---|---|---|---|---|
| `landingWhy3Desc` | 555 | Only reviewed batches reach the Buyer Pack. | เฉพาะแบทช์ที่ตรวจสอบแล้วเข้าสู่ Buyer Pack | เฉพาะแบทช์ที่ตรวจทานแล้วเข้าสู่ Buyer Pack |
| `landingOrgItem2Desc` | 566 | Stock ready for review | สต็อกที่พร้อมตรวจสอบ | สต็อกที่พร้อมตรวจทาน |

## Reviewed and judged safe as-is (no action needed)

| Key | Line | English | Thai | Why it's fine |
|---|---|---|---|---|
| `landingWhy1Desc` | 551 | Checked against documents and COA before listing. | ตรวจสอบกับเอกสารและ COA ก่อนขึ้นบัญชี | English itself says "Checked," so ตรวจสอบ (checked) matches — not an overclaim, no mismatch with the softened "reviewed" framing used elsewhere. |

---

## How to action this

1. Have a native Thai speaker read each "New Thai" value above in context on
   the live landing page (`https://ddp-brokerage-demo.onrender.com`, EN/TH
   toggle in the top nav).
2. Confirm ตรวจทาน ("reviewed"/"looked over") reads as a softer, more
   accurate claim than ตรวจสอบ ("checked"/"verified"/"inspected") in each
   context — i.e. it doesn't imply DDP has independently certified or
   guaranteed the underlying data.
3. For the two "not yet changed" rows, apply the suggested replacement in
   `src/translations.ts` once confirmed (or supply a better native phrasing).
4. Once confirmed, remove the corresponding `// NOTE: ... needs native
   speaker review` comments in `src/translations.ts` and delete the matching
   rows from this file (or mark them done).

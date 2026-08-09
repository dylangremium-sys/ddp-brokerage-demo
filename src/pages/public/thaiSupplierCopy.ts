// ─── Thai supplier page: the strings, and where each one came from ──────────
//
// This page is for Thai producers, and supply acquisition is the commercial
// focus. It is also the page most likely to be judged on how the Thai reads:
// the audience is licensed operators and their compliance staff, and stilted
// Thai would undermine the page more than a missing section would.
//
// SO EVERY STRING IS LABELLED BY PROVENANCE, and there are only three kinds.
//
//   EXISTING   Human-written Thai already in translations.ts, referenced by
//              key and not retyped. This is the majority of the page — both
//              legal notices, the hero, the four process steps, the brand
//              descriptor, the review note. None of it was translated here.
//
//   DRAFTED    Thai written for this page by a machine, from the brief. Short,
//              structural, and technical: section headings and the document
//              list. Every one carries the English it was written from, so a
//              Thai reviewer can check it without reading the code.
//              NEEDS_NATIVE_REVIEW below is the list of these.
//
//   PENDING    Sections the brief asks for that have no cleared wording in any
//              language. They are NOT on the page. No placeholder is rendered
//              to a visitor — a supplier reading "coming soon" learns less than
//              nothing about whether this company is serious.
//
// WHY THE PAGE SHIPS noindex
//   Because of DRAFTED and PENDING together. Publishing a page to search
//   engines when a third of its sections are missing and its new Thai has not
//   been read by a Thai speaker would spend the one first impression this
//   audience gives. The register entry is `noindex,nofollow`, so the sitemap
//   generator excludes it automatically. Clearing it to index is a two-line
//   change: the register's robots value, and the hand-written URL list in
//   crawlPolicyFiles.test.ts.

/**
 * Thai drafted for this page, each with the English it came from.
 *
 * A reviewer should read the `th` against the `en` and correct the `th` in
 * place. Nothing here is load-bearing for compliance — the sentences that bound
 * what the company claims are all EXISTING strings pulled from translations.ts.
 */
export const NEEDS_NATIVE_REVIEW = [
  { key: 'headingSell', en: 'Sell to a European buyer', th: 'ขายให้ผู้ซื้อในยุโรป' },
  { key: 'headingBuy', en: 'What we buy', th: 'เรารับซื้ออะไร' },
  { key: 'headingDocuments', en: 'What we need from you', th: 'สิ่งที่เราต้องการจากคุณ' },
  {
    key: 'licenceAbsolute',
    en: 'A current Thai licence, valid at the time of supply. We cannot work with unlicensed material and we do not make exceptions.',
    th: 'ใบอนุญาตไทยที่ยังมีผลบังคับใช้ ณ เวลาที่จัดหา เราไม่สามารถทำงานกับสินค้าที่ไม่มีใบอนุญาตได้ และไม่มีข้อยกเว้น',
  },
  { key: 'sendWhatYouHave', en: 'Beyond that, send what you have.', th: 'นอกเหนือจากนั้น ส่งสิ่งที่คุณมีมาได้เลย' },
  { key: 'helpfulNotRequired', en: 'Helpful, but not required to start:', th: 'มีประโยชน์ แต่ไม่จำเป็นต้องมีครบเพื่อเริ่มต้น:' },
  { key: 'docGacp', en: 'GACP certification', th: 'การรับรอง GACP' },
  {
    key: 'sendAnyway',
    en: 'If some of this is missing, or you are unsure whether yours is correct, send it anyway. Telling you what is missing is part of what we do.',
    th: 'หากขาดบางอย่าง หรือคุณไม่แน่ใจว่าเอกสารของคุณถูกต้องหรือไม่ ส่งมาได้เลย การบอกคุณว่าขาดอะไรคือส่วนหนึ่งของงานที่เราทำ',
  },
  { key: 'headingNext', en: 'What happens after you apply', th: 'ขั้นตอนหลังจากยื่นคำขอ' },
  { key: 'step1', en: 'You send your details through the supplier form', th: 'คุณส่งรายละเอียดผ่านแบบฟอร์มผู้จัดหาสินค้า' },
  { key: 'step2', en: 'Our team reviews what you have submitted', th: 'ทีมงานของเราตรวจสอบสิ่งที่คุณยื่นมา' },
  { key: 'step3', en: 'We come back to you on what we can place and what is missing', th: 'เราจะติดต่อกลับเรื่องสิ่งที่เราจัดหาให้ได้ และสิ่งที่ยังขาด' },
  { key: 'step4', en: 'If we can work together, we email an invitation to create your account', th: 'หากเราทำงานร่วมกันได้ เราจะส่งคำเชิญทางอีเมลเพื่อสร้างบัญชีของคุณ' },
  { key: 'headingProcess', en: 'How supply is reviewed', th: 'ขั้นตอนการตรวจสอบอุปทาน' },
  { key: 'headingAfter', en: 'After you apply', th: 'หลังจากยื่นคำขอ' },
  { key: 'headingLimits', en: 'What DDP does not do', th: 'สิ่งที่ DDP ไม่ได้ทำ' },
  { key: 'headingEligibility', en: 'Who may use this platform', th: 'ใครใช้แพลตฟอร์มนี้ได้' },
  {
    key: 'docCoa',
    en: 'A batch-specific COA from a laboratory accredited to ISO/IEC 17025',
    th: 'COA เฉพาะแบทช์ จากห้องปฏิบัติการที่ได้รับการรับรองมาตรฐาน ISO/IEC 17025',
  },
  {
    key: 'docThc',
    en: 'Total THC, calculated from THCA using the 0.877 factor — not delta-9 THC alone',
    th: 'ค่า THC รวม คำนวณจาก THCA ด้วยแฟกเตอร์ 0.877 ไม่ใช่ค่าเดลตา-9 THC เพียงอย่างเดียว',
  },
  {
    key: 'docPanel',
    en: 'A full analytical panel, not a summary certificate',
    th: 'ผลวิเคราะห์ครบชุด ไม่ใช่ใบสรุปผล',
  },
  {
    key: 'docBatchRecords',
    // "บันทึกแบทช์" is the wording already used in landingHero1, kept for consistency.
    en: 'Batch records for the supply being offered',
    th: 'บันทึกแบทช์ของอุปทานที่เสนอ',
  },
  {
    key: 'docNote',
    en: 'Documents are reviewed as submitted. DDP does not obtain them on your behalf.',
    th: 'เอกสารจะได้รับการตรวจสอบตามที่ยื่นมา DDP ไม่ได้จัดหาเอกสารแทนคุณ',
  },
] as const

type ReviewKey = (typeof NEEDS_NATIVE_REVIEW)[number]['key']

/** The drafted Thai, by key. */
export const DRAFTED: Record<ReviewKey, string> = Object.fromEntries(
  NEEDS_NATIVE_REVIEW.map(({ key, th }) => [key, th]),
) as Record<ReviewKey, string>

/**
 * Sections the brief asks for that are NOT on the page, and why.
 *
 * Each needs wording cleared in English first — none of it exists in
 * translations.ts, and none of it can be written here without asserting a
 * commercial commitment nobody has approved. thaiSupplierPage.test.ts asserts
 * this list is non-empty and that none of it has quietly been rendered, so a
 * gap cannot be closed by writing Thai without the English being cleared too.
 */
export const PENDING_SECTIONS = [
  {
    section: 'How long the review takes',
    why: 'The sequence is published; the duration is not. No timeline has been cleared, and an invented one is a promise. Add "We come back within N working days" to step three the moment a number can be committed to — a duration converts far better than a bare sequence.',
  },
] as const

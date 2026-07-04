import type { Lang } from '../../types'

export type StatusKey =
  | 'claimed'
  | 'documented'
  | 'verified'
  | 'missing-evidence'
  | 'hold'
  | 'reject'
  | 'buyer-ready'
  | 'review-pending'
  | 'coa-received'
  | 'coa-missing'
  | 'progress'

const STATUS_LABEL: Record<StatusKey, { en: string; th: string; cls: string }> = {
  'claimed':          { en: 'Claimed',          th: 'แจ้งเอง',              cls: 'status-claimed' },
  'documented':       { en: 'Documented',       th: 'มีเอกสารรองรับ',       cls: 'status-documented' },
  'verified':         { en: 'Verified',         th: 'ตรวจสอบแล้ว',         cls: 'status-verified' },
  'missing-evidence': { en: 'Missing Evidence', th: 'หลักฐานไม่ครบ',       cls: 'status-missing' },
  'hold':             { en: 'Hold',             th: 'ระงับชั่วคราว',       cls: 'status-hold' },
  'reject':           { en: 'Reject',           th: 'ปฏิเสธ',              cls: 'status-reject' },
  'buyer-ready':      { en: 'Buyer-Ready',      th: 'พร้อมสำหรับผู้ซื้อ',   cls: 'status-buyer-ready' },
  'review-pending':   { en: 'Review Pending',   th: 'รอการตรวจสอบ',        cls: 'status-review-pending' },
  'coa-received':     { en: 'COA Received',     th: 'ได้รับ COA แล้ว',     cls: 'status-coa-received' },
  'coa-missing':      { en: 'COA Missing',      th: 'ไม่มี COA',           cls: 'status-coa-missing' },
  'progress':         { en: 'Progress',         th: 'ดำเนินการต่อ',        cls: 'status-progress' },
}

interface StatusBadgeProps {
  status: StatusKey
  lang?: Lang
}

/** Institutional status vocabulary shared across claim/document/verification surfaces. */
export function StatusBadge({ status, lang = 'en' }: StatusBadgeProps) {
  const s = STATUS_LABEL[status]
  return <span className={`status-pill ${s.cls}`}>{lang === 'th' ? s.th : s.en}</span>
}

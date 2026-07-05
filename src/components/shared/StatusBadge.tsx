import type { EvidenceStatus, Lang } from '../../types'

export type StatusKey =
  | 'claimed'
  | 'documented'
  | 'reviewed'
  | 'verified'
  | 'missing'
  | 'missing-evidence'
  | 'rejected'
  | 'expired'
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
  'reviewed':         { en: 'Reviewed',         th: 'ตรวจทานแล้ว',         cls: 'status-reviewed' },
  'verified':         { en: 'Verified',         th: 'ตรวจสอบแล้ว',         cls: 'status-verified' },
  'missing':          { en: 'Missing',          th: 'ไม่มีข้อมูล',          cls: 'status-missing' },
  'missing-evidence': { en: 'Missing Evidence', th: 'หลักฐานไม่ครบ',       cls: 'status-missing' },
  'rejected':         { en: 'Rejected',         th: 'ปฏิเสธแล้ว',          cls: 'status-reject' },
  'expired':          { en: 'Expired',          th: 'หมดอายุ',             cls: 'status-expired' },
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

/** Renders an EvidenceStatus value directly — the enum's values are a subset of StatusKey. */
export function EvidenceBadge({ status, lang = 'en' }: { status: EvidenceStatus; lang?: Lang }) {
  return <StatusBadge status={status as StatusKey} lang={lang} />
}

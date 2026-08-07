import type { Lang } from '../../types'
import type { UserProfile } from '../../services/auth'

/**
 * The buyer's surface — W3.1.
 *
 * Deliberately small, and deliberately honest about it.
 *
 * Production has admitted `buyer` as a profile role since migration 39 and
 * carries `organisations` / `organisation_memberships`, but no page existed for
 * a buyer to land on, so `resolvePostLoginDecision` fell them through to
 * `default:` and signed them straight back out. This is the door being
 * unlocked, not the building being finished.
 *
 * What this page must NOT do is more important than what it does. There is no
 * catalogue (W3.3), no search (W3.4), no enquiry or reservation (W3.6), and no
 * pack delivery (W3.5). A dashboard that implied any of those existed would be
 * the same class of defect as the "11/11 passed" badge recorded in W4 — a
 * surface asserting a capability the system does not have. So it states the
 * position plainly and points at the one channel that does work: the contact
 * addresses, verified receiving on 2026-08-07.
 */

interface Props {
  lang: Lang
  profile: UserProfile | null
  onSignOut: () => void
}

const CONTACT_EMAIL = 'partnerships@ddpbrokerage.com'

export default function BuyerDashboard({ lang, profile, onSignOut }: Props) {
  const isTh = lang === 'th'

  return (
    <div className="page-wrap" style={{ maxWidth: 640 }}>
      <div className="page-header">
        <div className="page-eyebrow">DDP Brokerage</div>
        <h1 className="page-title">
          {isTh ? 'บัญชีผู้ซื้อ' : 'Buyer account'}
        </h1>
        <p className="page-desc">
          {isTh
            ? `ยินดีต้อนรับ ${profile?.displayName ?? ''} — บัญชีของคุณใช้งานได้แล้ว`
            : `Welcome${profile?.displayName ? `, ${profile.displayName}` : ''} — your account is active.`}
        </p>
      </div>

      <div className="card form-card">
        <h2 className="form-section-title">
          {isTh ? 'สถานะปัจจุบัน' : 'Where things stand'}
        </h2>
        <p style={{ lineHeight: 1.7, marginBottom: 16 }}>
          {isTh
            ? 'ขณะนี้ยังไม่มีแคตตาล็อกสินค้าให้ค้นหาในระบบ DDP กำลังพัฒนาส่วนนี้อยู่ ' +
              'ระหว่างนี้ทีมงานจะติดต่อคุณโดยตรงเมื่อมีสินค้าที่ตรงกับความต้องการของคุณ'
            : 'There is no searchable catalogue in the product yet. DDP is building it. ' +
              'In the meantime the team works with you directly, and will contact you when supply matches what you are looking for.'}
        </p>
        <p style={{ lineHeight: 1.7 }}>
          {isTh
            ? 'สิ่งที่ยังไม่มีในระบบ: การค้นหาสินค้า การเปรียบเทียบล็อต การขอใบเสนอราคา และการจองสต็อกผ่านหน้าเว็บ'
            : 'Not yet in the product: browsing supply, comparing batches, raising a request for quote, and reserving stock online.'}
        </p>
      </div>

      <div className="card form-card" style={{ marginTop: 16 }}>
        <h2 className="form-section-title">{isTh ? 'ติดต่อ DDP' : 'Contact DDP'}</h2>
        <p style={{ lineHeight: 1.7, marginBottom: 12 }}>
          {isTh
            ? 'ส่งอีเมลถึงทีมงานได้โดยตรง เราตอบทุกฉบับ'
            : 'Email the team directly. Every message is read by a person.'}
        </p>
        <a className="btn btn-primary" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn btn-ghost-sm" onClick={onSignOut}>
          {isTh ? 'ออกจากระบบ' : 'Sign out'}
        </button>
      </div>
    </div>
  )
}

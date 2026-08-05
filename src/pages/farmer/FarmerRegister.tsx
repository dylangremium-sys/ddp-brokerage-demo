import { useState } from 'react'
import type { Lang } from '../../types'
import { submitAccessRequest, AccessRequestError } from '../../lib/accessRequestClient'
import FarmerQRCode from '../../components/shared/FarmerQRCode'

const THAI_PROVINCES = [
  'Amnat Charoen', 'Ang Thong', 'Bangkok', 'Bueng Kan', 'Buri Ram',
  'Chachoengsao', 'Chai Nat', 'Chaiyaphum', 'Chanthaburi', 'Chiang Mai',
  'Chiang Rai', 'Chon Buri', 'Chumphon', 'Kalasin', 'Kamphaeng Phet',
  'Kanchanaburi', 'Khon Kaen', 'Krabi', 'Lampang', 'Lamphun',
  'Loei', 'Lop Buri', 'Mae Hong Son', 'Maha Sarakham', 'Mukdahan',
  'Nakhon Nayok', 'Nakhon Pathom', 'Nakhon Phanom', 'Nakhon Ratchasima',
  'Nakhon Sawan', 'Nakhon Si Thammarat', 'Nan', 'Narathiwat',
  'Nong Bua Lam Phu', 'Nong Khai', 'Nonthaburi', 'Pathum Thani',
  'Pattani', 'Phang Nga', 'Phatthalung', 'Phayao', 'Phetchabun',
  'Phetchaburi', 'Phichit', 'Phitsanulok', 'Phra Nakhon Si Ayutthaya',
  'Phrae', 'Phuket', 'Prachin Buri', 'Prachuap Khiri Khan', 'Ranong',
  'Ratchaburi', 'Rayong', 'Roi Et', 'Sa Kaeo', 'Sakon Nakhon',
  'Samut Prakan', 'Samut Sakhon', 'Samut Songkhram', 'Sara Buri',
  'Satun', 'Si Sa Ket', 'Sing Buri', 'Songkhla', 'Sukhothai',
  'Suphan Buri', 'Surat Thani', 'Surin', 'Tak', 'Trang', 'Trat',
  'Ubon Ratchathani', 'Udon Thani', 'Uthai Thani', 'Uttaradit',
  'Yala', 'Yasothon',
]

type SubRole = 'Farmer' | 'Farm Manager' | 'Broker'

interface Props {
  lang: Lang
  onComplete: () => void
}

export default function FarmerRegister({ lang, onComplete }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [phone, setPhone] = useState('')
  const [province, setProvince] = useState('')
  const [role, setRole] = useState<SubRole>('Farmer')
  const [preferredLang, setPreferredLang] = useState<Lang>(lang)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const isThai = lang === 'th'

    if (!name.trim()) {
      setError(isThai ? 'กรุณากรอกชื่อ' : 'Name is required.')
      return
    }
    if (!email.trim()) {
      setError(isThai ? 'กรุณากรอกอีเมล' : 'Email is required.')
      return
    }
    if (!phone.trim()) {
      setError(isThai ? 'กรุณากรอกเบอร์โทรศัพท์' : 'Phone number is required.')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      // Sends a real enquiry to the admin queue. It does NOT create an account —
      // DDP accounts are provisioned by an administrator inviting by email.
      await submitAccessRequest({
        fullName: name,
        email,
        phone,
        province: province || '',
        position: role,
        preferredLanguage: preferredLang,
      })
      setSubmitted(true)
    } catch (err) {
      if (err instanceof AccessRequestError && err.code === 'backend_unavailable') {
        // The intake table is not in this environment yet. Do not tell the
        // visitor to retry — it cannot succeed. Give them another route.
        setError(
          isThai
            ? 'ขณะนี้ยังไม่เปิดรับคำขอผ่านแบบฟอร์ม กรุณาติดต่อทีมงาน DDP โดยตรง'
            : 'The request form is not available yet. Please contact the DDP team directly.',
        )
      } else {
        setError(
          err instanceof AccessRequestError
            ? (isThai ? 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' : err.message)
            : (isThai ? 'ส่งคำขอไม่สำเร็จ' : 'The request could not be sent.'),
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  const isTh = lang === 'th'

  // Truthful confirmation. Previously this routed straight to a farmer dashboard
  // that requires a session the form never created, so the visitor hit a dead end.
  if (submitted) {
    return (
      <div className="page-wrap auth-page">
        <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="page-title">
            {isTh ? 'ได้รับคำขอของคุณแล้ว' : 'We have your request'}
          </h1>
        </div>
        <div className="card form-card auth-card">
          <p>
            {isTh
              ? 'ทีมงาน DDP จะตรวจสอบคำขอของคุณ และหากผ่านการพิจารณา เราจะส่งคำเชิญไปยังอีเมลของคุณเพื่อสร้างบัญชี'
              : 'The DDP team will review your request. If accepted, we will email you an invitation to create your account.'}
          </p>
          <p className="td-muted" style={{ fontSize: 13 }}>
            {isTh
              ? 'บัญชีผู้จัดหาสินค้าออกให้โดยผู้ดูแลระบบเท่านั้น คุณยังไม่มีบัญชีในขั้นตอนนี้'
              : 'Supplier accounts are issued by an administrator only. You do not have an account yet.'}
          </p>
          <p className="td-muted" style={{ fontSize: 13 }}>
            {isTh ? 'อีเมลที่ใช้ติดต่อ: ' : 'We will contact you at: '}
            <strong>{email.trim()}</strong>
          </p>
          <button
            type="button"
            className="btn btn-review btn-lg"
            style={{ width: '100%', marginTop: 16 }}
            onClick={onComplete}
          >
            {isTh ? 'กลับสู่หน้าแรก' : 'Back to home'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrap auth-page">
      <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
        <div className="page-eyebrow">DDP Brokerage</div>
        <h1 className="page-title">
          {isTh ? 'สมัครเป็นผู้จัดหาสินค้า' : 'Join as a Supplier'}
        </h1>
        <p className="page-desc">
          {isTh
            ? 'ใช้เวลาแค่ 2 นาที ทีมงานจะตรวจสอบและส่งคำเชิญทางอีเมล'
            : 'It takes 2 minutes. Our team reviews each request and sends an invitation by email.'}
        </p>
      </div>

      {/* QR code share card — lets administrators print or forward the link */}
      <div className="card form-card auth-card" style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
          {isTh ? 'แชร์ลิงก์นี้ให้เกษตรกร' : 'Share this link with farmers'}
        </div>
        <FarmerQRCode size={180} />
        <p className="td-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {isTh
            ? 'สแกน QR หรือส่งลิงก์ /farmer เพื่อเปิดฟอร์มนี้โดยตรง'
            : 'Scan the QR code or share the /farmer link to open this form directly.'}
        </p>
      </div>

      <div className="card form-card auth-card">
        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={e => { void handleSubmit(e) }}>
          <label className="field">
            <span>{isTh ? 'ชื่อ หรือชื่อฟาร์ม' : 'Your name or farm nickname'}</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              placeholder={isTh ? 'เช่น สวนพฤกษา' : 'e.g. Green Valley Farm'}
              autoComplete="name"
            />
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{isTh ? 'อีเมล' : 'Email address'}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder={isTh ? 'เช่น somchai@example.com' : 'e.g. somchai@example.com'}
              autoComplete="email"
            />
            <span className="td-muted" style={{ fontSize: 12 }}>
              {isTh ? 'เราจะส่งคำเชิญไปยังอีเมลนี้' : 'Your invitation will be sent to this address.'}
            </span>
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{isTh ? 'เบอร์โทรศัพท์' : 'Phone number'}</span>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              placeholder={isTh ? 'เช่น 0812345678' : 'e.g. 0812345678'}
              autoComplete="tel"
            />
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{isTh ? 'จังหวัด' : 'Province'}</span>
            <select value={province} onChange={e => setProvince(e.target.value)}>
              <option value="">{isTh ? 'เลือกจังหวัด' : 'Select your province'}</option>
              {THAI_PROVINCES.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{isTh ? 'บทบาทของคุณ' : 'Your role'}</span>
            <div className="role-selector">
              {(['Farmer', 'Farm Manager', 'Broker'] as SubRole[]).map(r => (
                <button
                  key={r}
                  type="button"
                  className={`role-btn${role === r ? ' role-btn-active' : ''}`}
                  onClick={() => setRole(r)}
                >
                  {r === 'Farmer'
                    ? (isTh ? 'เกษตรกร' : 'Farmer')
                    : r === 'Farm Manager'
                      ? (isTh ? 'ผู้จัดการฟาร์ม' : 'Farm Manager')
                      : (isTh ? 'นายหน้า' : 'Broker')}
                </button>
              ))}
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{isTh ? 'ภาษาที่ต้องการ' : 'Preferred language'}</span>
            <div className="role-selector">
              <button
                type="button"
                className={`role-btn${preferredLang === 'th' ? ' role-btn-active' : ''}`}
                onClick={() => setPreferredLang('th')}
              >ภาษาไทย</button>
              <button
                type="button"
                className={`role-btn${preferredLang === 'en' ? ' role-btn-active' : ''}`}
                onClick={() => setPreferredLang('en')}
              >English</button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={submitting}
            style={{ width: '100%', marginTop: 24 }}
          >
            {submitting
              ? (isTh ? 'กำลังส่ง…' : 'Sending…')
              : (isTh ? 'ขอเข้าใช้งาน' : 'Request access')}
          </button>
        </form>
      </div>
    </div>
  )
}

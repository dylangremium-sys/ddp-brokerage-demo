import { useState } from 'react'
import type { Lang } from '../../types'
import { T } from '../../translations'
import { submitAccessRequest, AccessRequestError } from '../../lib/accessRequestClient'
import FarmerQRCode from '../../components/shared/FarmerQRCode'
import LangToggle from '../../components/shared/LangToggle'

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
  /**
   * This page is the QR-code landing spot, and it is a PUBLIC page — the navbar
   * that carries the language toggle is not rendered here at all. Without a
   * toggle of its own, a Thai farm arriving by QR had no way to reach the Thai
   * interface. It is the one screen that most needs one.
   */
  setLang: (l: Lang) => void
  onComplete: () => void
}

export default function FarmerRegister({ lang, setLang, onComplete }: Props) {
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

    if (!name.trim()) {
      setError(copy.farmerRegErrNameRequired)
      return
    }
    if (!email.trim()) {
      setError(copy.farmerRegErrEmailRequired)
      return
    }
    if (!phone.trim()) {
      setError(copy.farmerRegErrPhoneRequired)
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
        setError(copy.farmerRegErrIntakeClosed)
      } else {
        // DELIBERATE CHANGE, worth naming: the English path used to show
        // err.message here — the raw message from the server — while the Thai
        // path showed a fixed sentence. So an English visitor could be handed
        // an untranslated internal string, and a Thai visitor never could.
        // Both now get the same reviewed wording. The specific error is still
        // available to whoever is debugging; it is just not shown to a supplier
        // who cannot act on it.
        setError(
          err instanceof AccessRequestError ? copy.farmerRegErrRetry : copy.farmerRegErrGeneric,
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  const copy = T[lang]

  // Truthful confirmation. Previously this routed straight to a farmer dashboard
  // that requires a session the form never created, so the visitor hit a dead end.
  if (submitted) {
    return (
      <div className="page-wrap auth-page">
        <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="page-title">
            {copy.farmerRegSubmittedTitle}
          </h1>
        </div>
        <div className="card form-card auth-card">
          <p>
            {copy.farmerRegReviewNote}
          </p>
          <p className="td-muted" style={{ fontSize: 13 }}>
            {copy.farmerRegAdminOnlyNote}
          </p>
          <p className="td-muted" style={{ fontSize: 13 }}>
            {copy.farmerRegContactAt}
            <strong>{email.trim()}</strong>
          </p>
          <button
            type="button"
            className="btn btn-review btn-lg"
            style={{ width: '100%', marginTop: 16 }}
            onClick={onComplete}
          >
            {copy.farmerRegBackHome}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrap auth-page">
      {/* First thing on the page, before any English prose, because a farmer
          who cannot read the heading needs to find this without reading it. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 480, margin: '0 auto 8px' }}>
        <LangToggle lang={lang} setLang={setLang} />
      </div>
      <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
        <div className="page-eyebrow">DDP Brokerage</div>
        <h1 className="page-title">
          {copy.farmerRegHeading}
        </h1>
        <p className="page-desc">
          {copy.farmerRegTwoMinutes}
        </p>
      </div>

      {/* QR code share card — lets administrators print or forward the link */}
      <div className="card form-card auth-card" style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#444' }}>
          {copy.farmerRegShareLink}
        </div>
        <FarmerQRCode size={180} />
        <p className="td-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {copy.farmerRegQrHint}
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
            <span>{copy.farmerRegNameLabel}</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              placeholder={copy.farmerRegNamePlaceholder}
              autoComplete="name"
            />
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{copy.farmerRegEmailLabel}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder={copy.farmerRegEmailPlaceholder}
              autoComplete="email"
            />
            <span className="td-muted" style={{ fontSize: 12 }}>
              {copy.farmerRegEmailHint}
            </span>
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{copy.farmerRegPhoneLabel}</span>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              placeholder={copy.farmerRegPhonePlaceholder}
              autoComplete="tel"
            />
          </label>

          <label className="field" style={{ marginTop: 14 }}>
            <span>{copy.farmerRegProvinceLabel}</span>
            <select value={province} onChange={e => setProvince(e.target.value)}>
              <option value="">{copy.farmerRegProvincePlaceholder}</option>
              {THAI_PROVINCES.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{copy.farmerRegRoleLabel}</span>
            <div className="role-selector">
              {(['Farmer', 'Farm Manager', 'Broker'] as SubRole[]).map(r => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={role === r}
                  className={`role-btn${role === r ? ' role-btn-active' : ''}`}
                  onClick={() => setRole(r)}
                >
                  {r === 'Farmer'
                    ? (copy.farmerRegRoleFarmer)
                    : r === 'Farm Manager'
                      ? (copy.farmerRegRoleManager)
                      : (copy.farmerRegRoleBroker)}
                </button>
              ))}
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{copy.farmerRegPreferredLang}</span>
            <div className="role-selector">
              <button
                type="button"
                aria-pressed={preferredLang === 'th'}
                className={`role-btn${preferredLang === 'th' ? ' role-btn-active' : ''}`}
                onClick={() => setPreferredLang('th')}
              >ภาษาไทย</button>
              <button
                type="button"
                aria-pressed={preferredLang === 'en'}
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
              ? (copy.farmerRegSending)
              : (copy.farmerRegSubmit)}
          </button>
        </form>
      </div>
    </div>
  )
}

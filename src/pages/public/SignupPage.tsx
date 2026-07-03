import { useState } from 'react'
import { signUpFarmer } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  onSuccess: () => void
  onGoLogin: () => void
}

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

type FarmerSubRole = 'Farmer' | 'Farm Manager' | 'Broker'

export default function SignupPage({ lang = 'en', onSuccess, onGoLogin }: Props) {
  const t = T[lang]
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [lineId, setLineId] = useState('')
  const [province, setProvince] = useState('')
  const [farmerSubRole, setFarmerSubRole] = useState<FarmerSubRole>('Farmer')
  const [preferredLang, setPreferredLang] = useState<'th' | 'en'>(lang)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!displayName.trim()) { setError('Name is required.'); return }
    if (!phone.trim()) { setError(lang === 'th' ? 'กรุณากรอกเบอร์โทรศัพท์' : 'Phone number is required.'); return }
    if (!password || password.length < 6) { setError(lang === 'th' ? 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' : 'Password must be at least 6 characters.'); return }
    setError(null)
    setLoading(true)

    // Phone number becomes the auth email if no email provided
    const authEmail = email.trim() || `${phone.replace(/\D/g, '')}@ddp-farmer.local`

    try {
      const result = await signUpFarmer(authEmail, password, displayName, {
        phoneNumber: phone,
        lineId,
        preferredLang,
        farmerSubRole,
        province,
      })
      if (result.session) {
        onSuccess()
      } else {
        setAwaitingConfirmation(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed')
    } finally {
      setLoading(false)
    }
  }

  if (awaitingConfirmation) {
    return (
      <div className="page-wrap auth-page">
        <div className="card form-card auth-card">
          <div className="alert alert-success" style={{ marginBottom: 20 }}>
            <strong>{lang === 'th' ? 'ตรวจสอบอีเมล' : 'Check your email.'}</strong>{' '}
            {t.signupSuccessEmail}
          </div>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onGoLogin}>
            {lang === 'th' ? 'ไปที่หน้าเข้าสู่ระบบ' : 'Go to Sign In'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrap auth-page">
      <div className="card form-card auth-card">
        <div className="auth-card-brand">
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="auth-card-title">{t.joinNetwork}</h1>
          <p className="page-desc">{t.signupTagline}</p>
        </div>

        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Name */}
          <label className="field">
            <span>{lang === 'th' ? 'ชื่อ หรือชื่อฟาร์ม' : 'Your name or farm nickname'}</span>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              required
              placeholder={lang === 'th' ? 'เช่น สวนพฤกษา' : 'e.g. Green Valley Farm'}
              autoComplete="name"
            />
          </label>

          {/* Phone */}
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.phoneLabel}</span>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              placeholder={t.phonePlaceholder}
              autoComplete="tel"
            />
          </label>

          {/* LINE ID */}
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.lineIdLabel}</span>
            <input
              value={lineId}
              onChange={e => setLineId(e.target.value)}
              placeholder={t.lineIdPlaceholder}
              autoComplete="off"
            />
          </label>

          {/* Province */}
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.provinceLabel}</span>
            <select value={province} onChange={e => setProvince(e.target.value)}>
              <option value="">{t.provincePlaceholder}</option>
              {THAI_PROVINCES.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          {/* Role selector */}
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{t.farmerSubRoleLabel}</span>
            <div className="role-selector">
              {(['Farmer', 'Farm Manager', 'Broker'] as FarmerSubRole[]).map(r => (
                <button
                  key={r}
                  type="button"
                  className={`role-btn${farmerSubRole === r ? ' role-btn-active' : ''}`}
                  onClick={() => setFarmerSubRole(r)}
                >
                  {r === 'Farmer' ? t.roleFarmer : r === 'Farm Manager' ? t.roleFarmManager : t.roleBroker}
                </button>
              ))}
            </div>
          </div>

          {/* Language preference */}
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{t.preferredLangLabel}</span>
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

          {/* Email (optional) */}
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.emailOptionalLabel}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              placeholder={t.emailOptionalPlaceholder}
            />
            {!email && (
              <span className="field-hint">
                {lang === 'th'
                  ? 'ถ้าไม่ใส่อีเมล เราจะสร้างชื่อผู้ใช้จากเบอร์โทรของคุณ'
                  : 'If left blank, your phone number will be used as your login identifier.'}
              </span>
            )}
          </label>

          {/* Password */}
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.passwordLabel}</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={6}
              placeholder={lang === 'th' ? 'อย่างน้อย 6 ตัวอักษร' : 'At least 6 characters'}
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 24 }}
            disabled={loading}
          >
            {loading ? t.signingUp : t.signupBtn}
          </button>
        </form>

        <p className="auth-switch-text">
          {lang === 'th' ? 'มีบัญชีอยู่แล้ว?' : 'Already have an account?'}{' '}
          <button className="link-btn" onClick={onGoLogin}>
            {lang === 'th' ? 'เข้าสู่ระบบ' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  )
}

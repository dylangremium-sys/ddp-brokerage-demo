import { useState } from 'react'
import { signIn } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  onSuccess: () => void
  onGoSignup: () => void
}

export default function LoginPage({ lang = 'en', onSuccess, onGoSignup }: Props) {
  const t = T[lang]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signIn(email, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-wrap auth-page">
      <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
        <div className="page-eyebrow">DDP Brokerage</div>
        <h1 className="page-title">{t.loginHeading}</h1>
        <p className="page-desc">{t.loginDesc}</p>
      </div>

      <div className="card form-card auth-card">
        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>{t.loginEmailLabel}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <label className="field" style={{ marginTop: 14 }}>
            <span>{t.loginPasswordLabel}</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 22 }}
            disabled={loading}
          >
            {loading ? t.loginLoading : t.loginBtn}
          </button>
        </form>

        <p className="auth-switch-text">
          {t.loginSwitchPrompt}{' '}
          <button className="link-btn" onClick={onGoSignup}>
            {t.loginSwitchLink}
          </button>
        </p>

        <div className="auth-admin-note">
          {t.loginAdminNote}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { signUp } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  /** Back to the sign-in screen. */
  onSignIn: () => void
}

/**
 * Public self-registration.
 *
 * Creating an account here grants NO operational access. The server assigns the
 * 'pending' role (handle_new_user), RLS forbids self-promotion, and post-login
 * routing denies 'pending', so the account stays outside every farmer and admin
 * surface — and outside every inventory view — until a DDP admin provisions it.
 * The success state says so explicitly rather than implying access was granted.
 */
export default function SignUpPage({ lang = 'en', onSignIn }: Props) {
  const t = T[lang]
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<null | { needsEmailConfirmation: boolean }>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = await signUp(email, password, displayName.trim() || undefined)
      setDone(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="page-wrap auth-page">
        <div className="card form-card auth-card">
          <div className="auth-card-brand">
            <div className="page-eyebrow">DDP Brokerage</div>
            <h1 className="auth-card-title">{t.signupDoneHeading}</h1>
          </div>
          <div className="alert alert-info" style={{ marginTop: 0 }}>
            <strong>{t.signupPendingTitle}</strong>
            <p style={{ margin: '6px 0 0' }}>{t.signupPendingDetail}</p>
          </div>
          {done.needsEmailConfirmation && (
            <p className="page-desc" style={{ marginTop: 14 }}>{t.signupConfirmEmail}</p>
          )}
          <button
            type="button"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 22 }}
            onClick={onSignIn}
          >
            {t.loginBtn}
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
          <h1 className="auth-card-title">{t.signupHeading}</h1>
          <p className="page-desc">{t.signupDesc}</p>
        </div>

        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>{t.signupNameLabel}</span>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </label>
          <label className="field" style={{ marginTop: 14 }}>
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
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <p className="page-desc" style={{ marginTop: 14, fontSize: 12.5 }}>
            {t.signupApprovalNote}
          </p>
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 18 }}
            disabled={loading}
          >
            {loading ? t.signingUp : t.signupBtn}
          </button>
        </form>

        <p className="page-desc" style={{ marginTop: 18 }}>
          {t.signupSwitchPrompt}{' '}
          <button type="button" className="btn-link" onClick={onSignIn}>
            {t.signupSwitchLink}
          </button>
        </p>
      </div>
    </div>
  )
}

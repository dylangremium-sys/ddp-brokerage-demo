import { useEffect, useRef, useState } from 'react'
import { signIn } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  onSuccess: () => void
  onSupplierSignup: () => void
}

export default function LoginPage({ lang = 'en', onSuccess, onSupplierSignup }: Props) {
  const t = T[lang]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // A failed sign-in must be announced, not just painted. Focus stays on the
  // submit button after the request settles, so without this a screen-reader
  // user hears nothing and is left believing the form is still working. Moving
  // focus to the alert (which also carries role="alert") reads the failure out
  // the moment it appears.
  const errorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

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
      <div className="card form-card auth-card">
        <div className="auth-card-brand">
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="auth-card-title">{t.loginHeading}</h1>
          <p className="page-desc">{t.loginDesc}</p>
        </div>

        {error && (
          // role="alert" announces the failure to assistive technology, and
          // tabIndex={-1} lets the effect above move focus here programmatically
          // without adding the alert to the tab order.
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="alert alert-danger"
            style={{ marginTop: 0, marginBottom: 16 }}
          >
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
          <button
            type="button"
            className="btn btn-ghost btn-lg"
            style={{ width: '100%', marginTop: 12 }}
            onClick={onSupplierSignup}
          >
            {lang === 'th' ? 'สมัครเป็นผู้จัดหาสินค้า' : 'Supplier signup'}
          </button>
        </form>
      </div>
    </div>
  )
}

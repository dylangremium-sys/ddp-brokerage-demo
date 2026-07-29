import { useEffect, useRef, useState } from 'react'
import { requestPasswordReset } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  onBackToLogin: () => void
}

/**
 * "Forgot your password?" — the recovery half of the password flow.
 *
 * Also the escape hatch from a dead invite link: an invitation that expired
 * before the supplier opened it leaves a real account with no password, and
 * this screen is the only way back into it.
 *
 * NON-ENUMERATION: the confirmation is identical whether or not an account
 * exists for the address, and the email field is not cleared or flagged on a
 * miss. Supabase itself reports success for an unknown address for exactly this
 * reason; showing anything more specific here would hand an attacker a list of
 * which supplier addresses are registered.
 */
export default function ForgotPasswordPage({ lang = 'en', onBackToLogin }: Props) {
  const t = T[lang]
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const noticeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (sent || error) noticeRef.current?.focus()
  }, [sent, error])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSending(true)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (err) {
      // Only a genuine transport/configuration failure reaches here — an unknown
      // address is not an error. Reporting it is honest: silently showing the
      // success notice would leave a locked-out user waiting for an email that
      // was never sent.
      setError(err instanceof Error ? err.message : t.forgotFailed)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="page-wrap auth-page">
      <div className="card form-card auth-card">
        <div className="auth-card-brand">
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="auth-card-title">{t.forgotHeading}</h1>
          <p className="page-desc">{t.forgotDesc}</p>
        </div>

        {sent && (
          <div
            ref={noticeRef}
            role="status"
            tabIndex={-1}
            className="alert alert-success"
            style={{ marginTop: 0, marginBottom: 16 }}
          >
            {t.forgotSent}
          </div>
        )}

        {error && (
          <div
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
            className="alert alert-danger"
            style={{ marginTop: 0, marginBottom: 16 }}
          >
            {error}
          </div>
        )}

        {!sent && (
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
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              style={{ width: '100%', marginTop: 22 }}
              disabled={sending}
            >
              {sending ? t.forgotSending : t.forgotSubmit}
            </button>
          </form>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-lg"
          style={{ width: '100%', marginTop: 12 }}
          onClick={onBackToLogin}
        >
          {t.forgotBack}
        </button>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { hasActiveSession, setPassword } from '../../services/auth'
import { validateNewPassword, type PasswordRejection } from '../../lib/passwordPolicy'
import { T } from '../../translations'
import type { Lang } from '../../types'
import type { AuthRedirect } from '../../lib/authRedirect'

interface Props {
  lang?: Lang
  /** Why the user is here — decides the wording, not the behaviour. */
  redirect: AuthRedirect
  /** Called only after the password is genuinely saved. Routes by role. */
  onDone: () => void
  /** The dead-link escape hatch: go and request a fresh email. */
  onRequestNewLink: () => void
}

type Phase = 'checking' | 'ready' | 'unavailable'

/**
 * The screen an invited supplier or a password-recovering user lands on.
 *
 * This closes the onboarding dead end: before it existed, an invited supplier
 * clicked the link in their email, received one transient session and had
 * nowhere to choose a password. When the session expired the account was
 * unreachable forever, so no supplier could ever complete onboarding.
 *
 * The three states are deliberately distinct. "Checking" is shown while the
 * session is resolved, because a form rendered before that resolves would
 * accept a password it cannot save. "Unavailable" is shown for a spent or
 * expired link and always offers a way to get a new one — a dead end here is
 * the whole defect being fixed.
 */
export default function SetPasswordPage({ lang = 'en', redirect, onDone, onRequestNewLink }: Props) {
  const t = T[lang]
  const isRecovery = redirect.kind === 'recovery'

  const [phase, setPhase] = useState<Phase>(redirect.kind === 'error' ? 'unavailable' : 'checking')
  const [password, setPasswordValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Same accessibility contract as LoginPage: a failure that is only painted is
  // silent to a screen-reader user whose focus is still on the submit button.
  const errorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  // Resolve the session ONCE. supabase-js establishes it asynchronously from the
  // link's fragment, so this may run before the session exists; the auth
  // subscription in App re-renders us and the effect re-runs on `phase`
  // returning to 'checking' only via a fresh mount, so a short retry window is
  // used instead of trusting the first read.
  useEffect(() => {
    if (redirect.kind === 'error') return
    let active = true
    let attempts = 0

    async function check() {
      const ok = await hasActiveSession()
      if (!active) return
      if (ok) {
        setPhase('ready')
        return
      }
      // The link's session can take a moment to be exchanged. Give it a bounded
      // number of tries before declaring the link dead — reporting "expired" to
      // a user holding a perfectly good invite is the worse error of the two.
      if (++attempts < 10) {
        setTimeout(() => { if (active) void check() }, 250)
        return
      }
      setPhase('unavailable')
    }

    void check()
    return () => { active = false }
  }, [redirect.kind])

  const REJECTION_MESSAGE: Record<PasswordRejection, string> = {
    'empty': t.pwErrEmpty,
    'too-short': t.pwErrTooShort,
    'too-long': t.pwErrTooLong,
    'no-letter': t.pwErrNoLetter,
    'no-number': t.pwErrNoNumber,
    'mismatch': t.pwErrMismatch,
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const check = validateNewPassword(password, confirm)
    if (!check.ok) {
      setError(REJECTION_MESSAGE[check.reason])
      return
    }

    setSaving(true)
    try {
      await setPassword(password)
      // Navigate ONLY after the update resolves. Routing optimistically would
      // tell a user their password was saved when it was not, and they would
      // discover otherwise only once the transient session had expired.
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.pwErrSaveFailed)
      setSaving(false)
    }
  }

  const heading = isRecovery ? t.setPwHeadingRecovery : t.setPwHeadingInvite
  const description = isRecovery ? t.setPwDescRecovery : t.setPwDescInvite

  return (
    <div className="page-wrap auth-page">
      <div className="card form-card auth-card">
        <div className="auth-card-brand">
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="auth-card-title">
            {phase === 'unavailable' ? t.setPwLinkInvalidHeading : heading}
          </h1>
          <p className="page-desc">
            {phase === 'unavailable' ? t.setPwLinkInvalidBody : description}
          </p>
        </div>

        {phase === 'checking' && (
          <p className="muted" role="status">{t.setPwChecking}</p>
        )}

        {phase === 'unavailable' && (
          <>
            {redirect.kind === 'error' && redirect.description && (
              <div role="alert" className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
                {redirect.description}
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary btn-lg"
              style={{ width: '100%' }}
              onClick={onRequestNewLink}
            >
              {t.setPwRequestNew}
            </button>
          </>
        )}

        {phase === 'ready' && (
          <>
            {error && (
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
                <span>{t.setPwNewLabel}</span>
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPasswordValue(e.target.value)}
                  required
                  autoComplete="new-password"
                  autoFocus
                />
              </label>
              <div className="field-hint">{t.setPwHint}</div>

              <label className="field" style={{ marginTop: 14 }}>
                <span>{t.setPwConfirmLabel}</span>
                <input
                  type={reveal ? 'text' : 'password'}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </label>

              {/* Typing an unseen password twice on a phone keyboard is the most
                  common way this screen is abandoned. */}
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginTop: 10 }}
                onClick={() => setReveal(v => !v)}
                aria-pressed={reveal}
              >
                {reveal ? t.setPwHide : t.setPwShow}
              </button>

              <button
                type="submit"
                className="btn btn-primary btn-lg"
                style={{ width: '100%', marginTop: 22 }}
                disabled={saving}
              >
                {saving ? t.setPwSaving : t.setPwSubmit}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

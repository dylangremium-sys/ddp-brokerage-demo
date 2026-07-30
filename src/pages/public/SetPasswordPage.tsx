import { useEffect, useRef, useState } from 'react'
import { getSessionUserId, setPassword } from '../../services/auth'
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

  // The identity the LINK itself names, or null when it carried no usable
  // token. Everything below binds to this rather than to "some session exists".
  const linkSubject = redirect.kind === 'error' ? null : redirect.subject

  // A link that names nobody is dead on arrival — there is no session to bind
  // to and none may be borrowed from storage. Derived here rather than set from
  // inside the effect, so the screen never renders a password form for an
  // instant before withdrawing it.
  const [phase, setPhase] = useState<Phase>(linkSubject ? 'checking' : 'unavailable')
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

  // Resolve the session ONCE, and bind it to the identity the LINK names.
  //
  // supabase-js establishes the session asynchronously from the link's
  // fragment, so the first read may come back empty; a bounded retry window is
  // used, because telling a user with a perfectly good invite that it expired
  // is the worse of the two errors.
  //
  // The subject check is the load-bearing part. Accepting "some session exists"
  // meant that an admin already signed in on this browser who opened a spent
  // invite link (`#type=invite`, no usable token) satisfied the check — and
  // submitting then called updateUser against the ADMIN'S account, changing the
  // wrong password while the invited account stayed unreachable. A link with no
  // subject is a dead link, full stop; it never falls back to session storage
  // — that case is already resolved to 'unavailable' by the initial state above,
  // so this effect simply has nothing to do.
  useEffect(() => {
    let active = true
    let attempts = 0

    // Single exit: the cleanup is returned on EVERY path. Bailing out with a
    // bare `return` for a subject-less link meant this arrow returned a cleanup
    // down one branch and undefined down the other.
    const subject = linkSubject

    const check = async (): Promise<void> => {
      if (!subject) return
      // A rejection here — getSession touching storage, a hostile environment —
      // previously escaped as an unhandled rejection and left the screen sitting
      // on "Checking your link…" forever, with no error and no way forward.
      // Treated as "no session yet" so it retries, then settles on the dead-link
      // state, which at least offers a route onward.
      const userId = await getSessionUserId().catch(() => null)
      if (!active) return
      if (userId && userId === subject) {
        setPhase('ready')
        return
      }
      // Retry only while NOTHING is signed in — the session may still be being
      // exchanged. A session belonging to somebody else is a settled answer and
      // is refused immediately; retrying could not turn it into the right one.
      if (!userId && ++attempts < 10) {
        setTimeout(() => { if (active) check() }, 250)
        return
      }
      setPhase('unavailable')
    }

    check()
    return () => { active = false }
  }, [linkSubject])

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

  // Known Supabase error codes mapped to OUR copy. The code is only ever a
  // lookup key — nothing from the URL reaches the DOM.
  const TRUSTED_REASON: Record<string, string> = {
    otp_expired: t.setPwReasonExpired,
    access_denied: t.setPwReasonUsed,
  }
  const reason =
    redirect.kind === 'error' && redirect.code ? TRUSTED_REASON[redirect.code] : undefined

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
            {/* Trusted copy chosen by error CODE. The URL's own
                `error_description` is never carried here and never rendered:
                it is attacker-controlled free text, and echoing it would let
                anyone display arbitrary phishing instructions on DDP's own
                branded origin without holding a token. An unrecognised code
                shows nothing extra rather than anything from the URL. */}
            {reason && (
              <div role="alert" className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
                {reason}
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

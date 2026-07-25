import { useState } from 'react'
import { signUp } from '../../services/auth'
import { T } from '../../translations'
import type { Lang } from '../../types'

interface Props {
  lang?: Lang
  /** Back to the sign-in screen. */
  onSignIn: () => void
}

interface FieldProps {
  label: string
  type: 'text' | 'email' | 'password'
  value: string
  onChange: (next: string) => void
  required?: boolean
  minLength?: number
  autoComplete?: string
  placeholder?: string
  marginTop?: boolean
}

/**
 * The auth card shell (page wrapper + card + branded header).
 *
 * Extracted purely so each caller's JSX tree stays shallow — it emits exactly
 * the same DOM as the inline markup it replaces, with the same class names in
 * the same order. No behaviour, state, or conditional depends on it.
 */
function AuthCard({ title, desc, children }: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="page-wrap auth-page">
      <div className="card form-card auth-card">
        <div className="auth-card-brand">
          <div className="page-eyebrow">DDP Brokerage</div>
          <h1 className="auth-card-title">{title}</h1>
          {desc && <p className="page-desc">{desc}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

/** One labelled input. Extracted so the form's JSX tree stays shallow. */
function Field({ label, type, value, onChange, marginTop, ...rest }: FieldProps) {
  return (
    <label className="field" style={marginTop ? { marginTop: 14 } : undefined}>
      <span>{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} {...rest} />
    </label>
  )
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
  const copy = T[lang]
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
      <AuthCard title={copy.signupDoneHeading}>
        <div className="alert alert-info" style={{ marginTop: 0 }}>
          <strong>{copy.signupPendingTitle}</strong>
          <p style={{ margin: '6px 0 0' }}>{copy.signupPendingDetail}</p>
        </div>
        {done.needsEmailConfirmation && (
          <p className="page-desc" style={{ marginTop: 14 }}>{copy.signupConfirmEmail}</p>
        )}
        <button
          type="button"
          className="btn btn-primary btn-lg"
          style={{ width: '100%', marginTop: 22 }}
          onClick={onSignIn}
        >
          {copy.loginBtn}
        </button>
      </AuthCard>
    )
  }

  return (
    <AuthCard title={copy.signupHeading} desc={copy.signupDesc}>
      {error && (
        <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <Field
          label={copy.signupNameLabel}
          type="text"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
        />
        <Field
          label={copy.loginEmailLabel}
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="email"
          placeholder="you@example.com"
          marginTop
        />
        <Field
          label={copy.loginPasswordLabel}
          type="password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete="new-password"
          marginTop
        />
        <p className="page-desc" style={{ marginTop: 14, fontSize: 12.5 }}>
          {copy.signupApprovalNote}
        </p>
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          style={{ width: '100%', marginTop: 18 }}
          disabled={loading}
        >
          {loading ? copy.signingUp : copy.signupBtn}
        </button>
      </form>

      <p className="page-desc" style={{ marginTop: 18 }}>
        {copy.signupSwitchPrompt}{' '}
        <button type="button" className="btn-link" onClick={onSignIn}>
          {copy.signupSwitchLink}
        </button>
      </p>
    </AuthCard>
  )
}

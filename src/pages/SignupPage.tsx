import { useState } from 'react'
import { signUpFarmer } from '../services/auth'

interface Props {
  onSuccess: () => void
  onGoLogin: () => void
}

export default function SignupPage({ onSuccess, onGoLogin }: Props) {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = await signUpFarmer(email, password, displayName)
      if (result.session) {
        // Email confirmation is disabled in Supabase dashboard — signed in immediately
        onSuccess()
      } else {
        // Email confirmation required — show "check your email" message
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
            <strong>Check your email.</strong> A confirmation link has been sent to{' '}
            <strong>{email}</strong>. Click the link, then sign in.
          </div>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onGoLogin}>
            Go to Sign In
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrap auth-page">
      <div className="page-header farmer-header" style={{ maxWidth: 480, margin: '0 auto 24px' }}>
        <div className="page-eyebrow">DDP Brokerage — Farmer Portal</div>
        <h1 className="page-title">Create farmer account</h1>
        <p className="page-desc">
          Register to submit your farm profile and inventory to DDP Brokerage.
        </p>
      </div>

      <div className="card form-card auth-card">
        <div className="auth-admin-note" style={{ marginBottom: 18 }}>
          This form creates a <strong>Farmer</strong> account. DDP Admin access is granted
          manually — contact the DDP team.
        </div>

        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Full name / Farm contact name</span>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              required
              placeholder="Your name"
              autoComplete="name"
            />
          </label>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Email address</span>
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
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={6}
              placeholder="At least 6 characters"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 22 }}
            disabled={loading}
          >
            {loading ? 'Creating account…' : 'Create farmer account'}
          </button>
        </form>

        <p className="auth-switch-text">
          Already have an account?{' '}
          <button className="link-btn" onClick={onGoLogin}>
            Sign in
          </button>
        </p>
      </div>
    </div>
  )
}

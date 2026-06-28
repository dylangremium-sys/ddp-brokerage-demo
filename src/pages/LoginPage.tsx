import { useState } from 'react'
import { signIn } from '../services/auth'

interface Props {
  onSuccess: () => void
  onGoSignup: () => void
}

export default function LoginPage({ onSuccess, onGoSignup }: Props) {
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
        <h1 className="page-title">Sign in</h1>
        <p className="page-desc">Access your DDP Brokerage account.</p>
      </div>

      <div className="card form-card auth-card">
        {error && (
          <div className="alert alert-danger" style={{ marginTop: 0, marginBottom: 16 }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <label className="field">
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
              autoComplete="current-password"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 22 }}
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch-text">
          New farmer?{' '}
          <button className="link-btn" onClick={onGoSignup}>
            Create a farmer account
          </button>
        </p>

        <div className="auth-admin-note">
          DDP Admin accounts are created by the DDP team — see README for setup instructions.
        </div>
      </div>
    </div>
  )
}

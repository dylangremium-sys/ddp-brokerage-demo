export default function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-wrap" style={{ textAlign: 'center', paddingTop: 80 }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ margin: '0 auto 16px' }} aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="1" stroke="var(--text-muted)" strokeWidth="1.5"/>
        <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="var(--text-muted)" strokeWidth="1.5"/>
        <circle cx="12" cy="16" r="1.5" fill="var(--text-muted)"/>
      </svg>
      <h2 style={{ color: 'var(--text)', marginBottom: 12 }}>Access Denied</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}>
        You don't have permission to view this page. DDP Admin access is required.
      </p>
      <button className="btn btn-primary" onClick={onBack}>Go back</button>
    </div>
  )
}

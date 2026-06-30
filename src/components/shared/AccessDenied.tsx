export default function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-wrap" style={{ textAlign: 'center', paddingTop: 80 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
      <h2 style={{ color: '#1e293b', marginBottom: 12 }}>Access Denied</h2>
      <p style={{ color: '#64748b', marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}>
        You don't have permission to view this page. DDP Admin access is required.
      </p>
      <button className="btn btn-primary" onClick={onBack}>Go back</button>
    </div>
  )
}

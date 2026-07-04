function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface DocumentCardProps {
  hasFile: boolean
  fileName?: string
  sizeBytes?: number
  issuedDate?: string
  verificationHash?: string
  signatoryAuthority?: string
  /** Whether a click-to-open action should render (caller decides visibility/permission gating). */
  openable?: boolean
  loading?: boolean
  onOpen?: () => void
  variant?: 'inline' | 'table-cell' | 'buyer-pack'
  missingText?: string
  /** 'error' (crimson, ✗ — a required document is absent) or 'muted' (neutral — not yet expected). */
  missingSeverity?: 'error' | 'muted'
  openLabel?: string
}

/**
 * Renders a document-vault asset record: filename, size, issued date and a
 * verification hash / signatory authority — replacing the old bare
 * "COA attached" + filename pattern duplicated across the review, master
 * inventory, and buyer-pack pages.
 */
export function DocumentCard({
  hasFile,
  fileName,
  sizeBytes,
  issuedDate,
  verificationHash,
  signatoryAuthority,
  openable = false,
  loading = false,
  onOpen,
  variant = 'inline',
  missingText = 'Not on file',
  missingSeverity = 'error',
  openLabel = 'Access Certificate of Analysis (COA)',
}: DocumentCardProps) {
  if (!hasFile) {
    return missingSeverity === 'error'
      ? <span className="text-missing">✗ {missingText}</span>
      : <span className="td-muted">{missingText}</span>
  }

  const size = formatBytes(sizeBytes)
  const metaParts = [size, issuedDate ? `Issued ${issuedDate}` : undefined].filter(Boolean)

  if (variant === 'table-cell') {
    return (
      <span className="doc-card doc-card--cell">
        <span className="coa-present">✓ COA</span>
        {openable && onOpen && (
          <button type="button" className="btn btn-ghost doc-card-open" onClick={onOpen} disabled={loading}>
            {loading ? '…' : 'View file'}
          </button>
        )}
      </span>
    )
  }

  if (variant === 'buyer-pack') {
    return (
      <span className="doc-card doc-card--buyer-pack">
        {openable && onOpen ? (
          <button type="button" className="btn btn-ghost no-print" onClick={onOpen} disabled={loading}>
            {loading ? '…' : (fileName || openLabel)}
          </button>
        ) : (
          <span className="coa-present">✓ {fileName || 'On file'}</span>
        )}
        {metaParts.length > 0 && <span className="td-muted doc-card-meta">{metaParts.join(' · ')}</span>}
      </span>
    )
  }

  // inline (detail-page) variant
  return (
    <span className="doc-card doc-card--inline">
      <span className="doc-card-row">
        <span className="doc-name">Document on file</span>
        {openable && onOpen && (
          <button type="button" className="btn btn-ghost doc-card-open" onClick={onOpen} disabled={loading}>
            {loading ? 'Loading…' : openLabel}
          </button>
        )}
      </span>
      {fileName && <span className="td-muted">{fileName}</span>}
      {metaParts.length > 0 && <span className="td-muted doc-card-meta">{metaParts.join(' · ')}</span>}
      {verificationHash && <span className="mono doc-card-hash">{verificationHash}</span>}
      {signatoryAuthority && <span className="td-muted doc-card-meta">Signed by {signatoryAuthority}</span>}
    </span>
  )
}

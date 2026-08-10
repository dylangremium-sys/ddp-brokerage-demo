/**
 * FarmerQRCode — renders a QR code for the /farmer deep-link URL.
 *
 * Used on the farmer-register page so that administrators can screenshot or
 * print the code and post it at farm cooperatives or share via WhatsApp.
 * The QR code is generated at render time from window.location.origin so it
 * works in every environment (local dev, staging, production) without a
 * build-time configuration step.
 *
 * Provides a "Download PNG" button so staff can save the asset for print or
 * digital distribution.
 */

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface Props {
  /** Overrides the auto-detected URL — useful in tests or when the origin is
   *  not yet known (e.g. a static export preview). */
  url?: string
  /** Pixel size of the rendered canvas / downloaded PNG. Default: 240. */
  size?: number
}

export default function FarmerQRCode({ url, size = 240 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const targetUrl = url ?? (typeof window !== 'undefined' ? `${window.location.origin}/farmer` : '/farmer')

  useEffect(() => {
    // Single exit, always a cleanup function. The early `if (!canvas) return`
    // this replaces left the effect returning undefined on one path and a
    // function on the other. DeepSource's generic advice for that shape is
    // `return null` — which is wrong here specifically: React rejects anything
    // from an effect that is not a function or undefined, so returning null
    // would trade a lint warning for a runtime one. Guarding the body instead
    // satisfies both.
    let cancelled = false
    const canvas = canvasRef.current

    if (canvas) {
      QRCode.toCanvas(canvas, targetUrl, {
        width: size,
        margin: 2,
        color: { dark: '#1a2d1e', light: '#ffffff' },
      })
        .then(() => {
          if (!cancelled) setDataUrl(canvas.toDataURL('image/png'))
        })
        .catch(() => {
          if (!cancelled) setError(true)
        })
    }

    // Named declaration rather than an arrow: the analyser's rule is scoped to
    // arrow functions, and its suggested remedy (`return null`) is invalid for
    // an effect — React accepts only a function or undefined.
    function cancel() {
      cancelled = true
    }

    return cancel
  }, [targetUrl, size])

  function handleDownload() {
    if (!dataUrl) return
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = 'farmer-portal-qr.png'
    link.click()
  }

  return (
    <div className="farmer-qr-wrap">
      {error ? (
        <p className="td-muted" style={{ fontSize: 13 }}>QR code could not be generated.</p>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            width={size}
            height={size}
            style={{ display: 'block', borderRadius: 8, border: '1px solid #e0e0d0' }}
            aria-label={`QR code linking to ${targetUrl}`}
          />
          <p className="td-muted" style={{ fontSize: 11, marginTop: 6, textAlign: 'center', wordBreak: 'break-all' }}>
            {targetUrl}
          </p>
          <button
            type="button"
            className="btn btn-outline"
            style={{ marginTop: 8, fontSize: 12, padding: '5px 14px', width: '100%' }}
            onClick={handleDownload}
            disabled={!dataUrl}
          >
            Download PNG
          </button>
        </>
      )}
    </div>
  )
}

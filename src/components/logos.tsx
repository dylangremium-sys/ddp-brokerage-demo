import { useId } from 'react'

/**
 * DDPMonogramLogo — portrait cartouche with guilloché and corner ornaments.
 * Use in: navbar, sidebar, any compact app area.
 */
export function DDPMonogramLogo({ height = 48 }: { height?: number }) {
  const w = Math.round(height * (56 / 70))
  return (
    <svg
      width={w} height={height}
      viewBox="0 0 56 70"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="DDP"
    >
      {/* Background */}
      <rect width="56" height="70" fill="#07130F"/>

      {/* Guilloché — faint concentric rings */}
      <circle cx="28" cy="35" r="8"  stroke="#C6A15B" strokeWidth="0.5" opacity="0.07"/>
      <circle cx="28" cy="35" r="14" stroke="#C6A15B" strokeWidth="0.5" opacity="0.07"/>
      <circle cx="28" cy="35" r="20" stroke="#C6A15B" strokeWidth="0.5" opacity="0.07"/>
      <circle cx="28" cy="35" r="26" stroke="#C6A15B" strokeWidth="0.5" opacity="0.06"/>

      {/* Outer border rect */}
      <rect x="4" y="8" width="48" height="54" stroke="#C6A15B" strokeWidth="1.1" fill="none"/>

      {/* Corner bracket ornaments (heavier at each corner) */}
      <path d="M 4,19 L 4,8 L 15,8"    stroke="#C6A15B" strokeWidth="2.2" strokeLinecap="square" fill="none"/>
      <path d="M 41,8 L 52,8 L 52,19"   stroke="#C6A15B" strokeWidth="2.2" strokeLinecap="square" fill="none"/>
      <path d="M 4,51 L 4,62 L 15,62"   stroke="#C6A15B" strokeWidth="2.2" strokeLinecap="square" fill="none"/>
      <path d="M 41,62 L 52,62 L 52,51"  stroke="#C6A15B" strokeWidth="2.2" strokeLinecap="square" fill="none"/>

      {/* Top diamond (straddles the top border at centre) */}
      <polygon points="28,4 31,8 28,12 25,8" fill="#C6A15B"/>

      {/* Bottom diamond */}
      <polygon points="28,58 31,62 28,66 25,62" fill="#C6A15B"/>

      {/* DDP in editorial serif */}
      <text
        x="28" y="42"
        textAnchor="middle"
        fill="#C6A15B"
        fontSize="22"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="700"
        letterSpacing="1"
      >DDP</text>
    </svg>
  )
}

/**
 * DDPHeroWordmark — large editorial brand mark.
 * Use in: landing page hero only.
 */
export function DDPHeroWordmark() {
  return (
    <svg
      width="280" height="108"
      viewBox="0 0 280 108"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="DDP Brokerage"
    >
      {/* Large DDP in serif */}
      <text
        x="140" y="64"
        textAnchor="middle"
        fill="#C6A15B"
        fontSize="68"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="700"
        letterSpacing="8"
      >DDP</text>

      {/* Thin rule */}
      <line x1="24" y1="76" x2="256" y2="76" stroke="#C6A15B" strokeWidth="0.6" opacity="0.45"/>

      {/* Diamond ornament centred on rule */}
      <polygon points="140,72 143.5,76 140,80 136.5,76" fill="#C6A15B" opacity="0.8"/>

      {/* Subtext */}
      <text
        x="140" y="98"
        textAnchor="middle"
        fill="#C6A15B"
        fontSize="10.5"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="400"
        letterSpacing="6"
      >DDP BROKERAGE</text>
    </svg>
  )
}

/**
 * DDPVerifiedSupplySeal — circular compliance seal with curved text.
 * Use in: COA areas, DDPBuyerPreview, DDPMasterInventory, export/compliance screens only.
 */
export function DDPVerifiedSupplySeal({ size = 80 }: { size?: number }) {
  const uid = useId().replace(/:/g, '-')
  const topId  = `ddp-top-${uid}`
  const btmId  = `ddp-btm-${uid}`

  return (
    <svg
      width={size} height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="DDP Verified Supply"
    >
      {/*
        Scalloped outer ring — 24-point polygon alternating r=57 (peaks) and r=53 (valleys).
        Angles start at top (−90°), step 15° per point.
      */}
      <path
        d="M60,3 L73.7,8.8 L88.5,10.6 L97.5,22.5 L109.4,31.5 L111.2,46.3 L117,60
           L111.2,73.7 L109.4,88.5 L97.5,97.5 L88.5,109.4 L73.7,111.2 L60,117
           L46.3,111.2 L31.5,109.4 L22.5,97.5 L10.6,88.5 L8.8,73.7 L3,60
           L8.8,46.3 L10.6,31.5 L22.5,22.5 L31.5,10.6 L46.3,8.8 Z"
        stroke="#C6A15B"
        strokeWidth="1"
        fill="#07130F"
      />

      {/* Inner field */}
      <circle cx="60" cy="60" r="50" fill="#0A1A12"/>

      {/* Guilloché rings */}
      <circle cx="60" cy="60" r="16" stroke="#C6A15B" strokeWidth="0.4" opacity="0.08"/>
      <circle cx="60" cy="60" r="24" stroke="#C6A15B" strokeWidth="0.4" opacity="0.08"/>
      <circle cx="60" cy="60" r="32" stroke="#C6A15B" strokeWidth="0.4" opacity="0.08"/>

      {/* Border rings */}
      <circle cx="60" cy="60" r="50" stroke="#C6A15B" strokeWidth="0.8" opacity="0.65"/>
      <circle cx="60" cy="60" r="45" stroke="#C6A15B" strokeWidth="0.3" opacity="0.3"/>

      {/* Diamond markers at 12 o'clock and 6 o'clock */}
      <polygon points="60,8  62.5,13 60,18 57.5,13" fill="#C6A15B" opacity="0.85"/>
      <polygon points="60,102 62.5,107 60,112 57.5,107" fill="#C6A15B" opacity="0.85"/>

      {/* Arc paths for curved text (r=40) */}
      {/* Top arc — clockwise from left to right = text reads across the top */}
      <path id={topId} d="M 20,60 A 40,40 0 0 1 100,60" fill="none"/>
      {/* Bottom arc — counterclockwise = text reads across the bottom L→R */}
      <path id={btmId} d="M 20,60 A 40,40 0 0 0 100,60" fill="none"/>

      {/* Top curved text */}
      <text
        fill="#C6A15B"
        fontSize="8.5"
        fontFamily="Georgia, 'Times New Roman', serif"
        letterSpacing="2"
      >
        <textPath href={`#${topId}`} startOffset="50%" textAnchor="middle">
          DDP VERIFIED SUPPLY
        </textPath>
      </text>

      {/* Bottom curved text */}
      <text
        fill="#C6A15B"
        fontSize="6"
        fontFamily="Georgia, 'Times New Roman', serif"
        letterSpacing="1"
        opacity="0.75"
      >
        <textPath href={`#${btmId}`} startOffset="50%" textAnchor="middle">
          COMPLIANT · TRACEABLE · SECURE
        </textPath>
      </text>

      {/* Centre DDP */}
      <text
        x="60" y="67"
        textAnchor="middle"
        fill="#C6A15B"
        fontSize="22"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="700"
        letterSpacing="3"
      >DDP</text>
    </svg>
  )
}

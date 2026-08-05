# DDP Brokerage — Mobile & Typography Improvements

Apply all changes below to your local copy of the repo. Every section states
the file path, what to do, and the exact code. No changes are needed to any
other file.

---

## 1. `index.html` — Add Sarabun to Google Fonts

Find the existing `<link>` that loads Google Fonts and replace it with the
line below (adds `Sarabun:wght@300;400;500;600;700`):

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Noto+Serif:wght@400;500;600&family=Sarabun:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
```

---

## 2. `vite.config.ts` — Allow Replit/proxy hosts (dev only)

Inside `defineConfig({ ... })`, add a `server` block so the preview iframe
is not blocked when running through a reverse proxy:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,   // ← add this block
  },
  test: {
    // ... existing test config unchanged
  },
})
```

---

## 3. `src/App.css` — Four targeted edits

### 3a. Replace the `:root` accent tokens (lines ~2–12)

Old:
```css
--accent:        #64748B;
--accent-strong:  #334155;
--text-muted:  #93A1B2;
--border:      #29394D;
```

New:
```css
--accent:        #C6A24C;   /* brand gold — matches landing page */
--accent-strong:  #A8883A;
--text-muted:  #8FA2B5;    /* slightly warmer */
--border:      #2A3C52;    /* slightly warmer */
```

### 3b. Add Sarabun to the body font stack (line ~31)

Old:
```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

New:
```css
font-family: 'Inter', 'Sarabun', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

### 3c. Fix `.btn-primary:hover` box-shadow colour

Old:
```css
.btn-primary:hover {
  background: var(--accent-strong);
  box-shadow: 0 2px 10px rgba(100,116,139,0.25);
}
```

New:
```css
.btn-primary:hover {
  background: var(--accent-strong);
  box-shadow: 0 2px 10px rgba(198,162,76,0.28);
}
```

### 3d. Append the mobile + Thai CSS block at the very end of the file

Paste everything below at the bottom of `src/App.css`:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   FARMER PORTAL — MOBILE IMPROVEMENTS
   ─ Bottom tab nav, touch targets, layout fixes for phones ≤768px
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Farmer bottom navigation bar ── */
.farmer-mobile-nav {
  display: none; /* hidden on desktop — shown only at ≤768px below */
}

@media (max-width: 768px) {
  /* Show the fixed bottom nav */
  .farmer-mobile-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 300;
    background: #081a14;
    border-top: 1px solid rgba(198,161,91,0.18);
    padding: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    height: calc(62px + env(safe-area-inset-bottom, 0px));
    align-items: stretch;
  }

  /* Each tab item */
  .fmn-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    border: none;
    color: rgba(255,255,255,0.45);
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0;
    cursor: pointer;
    padding: 8px 4px;
    transition: color 0.14s;
    -webkit-tap-highlight-color: transparent;
    min-width: 0;
  }

  .fmn-item:active {
    background: rgba(198,161,91,0.07);
  }

  .fmn-item.fmn-active {
    color: var(--accent, #C6A24C);
  }

  .fmn-icon-wrap {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
  }

  .fmn-item.fmn-active .fmn-icon-wrap svg {
    stroke-width: 2.1;
  }

  .fmn-label {
    line-height: 1;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Badge (unread count on Requests tab) */
  .fmn-badge {
    position: absolute;
    top: -3px;
    right: -5px;
    background: #e84e4e;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    border-radius: 20px;
    min-width: 15px;
    height: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 3px;
    line-height: 1;
  }

  /* Hide the desktop farmer nav — bottom nav takes over on mobile */
  .farmer-nav-topbar {
    display: none;
  }

  /* Push page content above the fixed bottom nav */
  .main-content.eo-farmer {
    padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  }

  /* Tighten page headers on small screens */
  .page-header {
    padding: 16px 16px 12px;
  }

  .eo-farmer .farmer-header {
    padding: 14px 16px 10px;
  }

  /* Form cards: less wasted horizontal space */
  .eo-farmer .form-card {
    padding: 16px 14px;
  }

  /* Welcome card */
  .eo-farmer .dashboard-welcome-card {
    padding: 16px 14px;
  }

  /* 2-col form grids collapse to 1 col inside the farmer portal */
  .eo-farmer .form-grid-2 {
    grid-template-columns: 1fr;
  }

  /* Buttons go full-width on mobile inside the farmer portal */
  .eo-farmer .btn-primary,
  .eo-farmer .btn-ghost {
    width: 100%;
    justify-content: center;
  }

  /* Filter/pill rows scroll horizontally instead of wrapping */
  .filter-row,
  .pill-row {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 4px;
    gap: 6px;
  }

  /* Inventory table: horizontal scroll */
  .eo-farmer .inv-table-wrap,
  .ddp-wrap .inv-table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Status badges: tighter padding */
  .status-badge,
  .badge {
    padding: 1px 5px;
  }
}

/* Very small phones (≤400px) */
@media (max-width: 400px) {
  .main-content {
    padding: 16px 12px;
  }

  .eo-farmer .form-card {
    padding: 14px 12px;
  }

  .fmn-item {
    font-size: 9px;
  }

  .quick-action-grid {
    grid-template-columns: 1fr;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THAI TYPOGRAPHY OVERRIDES  :lang(th)
   Sarabun is loaded from Google Fonts. The HTML lang attribute is set
   dynamically by App.tsx so these selectors activate when the user switches
   to Thai.
   Rules:
   • letter-spacing must be 0 — Thai glyph stacking breaks with any spacing
   • line-height needs room for above/below-baseline vowels and tone marks
   • Minimum 13–14px for anything a farmer reads; stacked marks at ≤12px
     lose their distinguishing detail on a phone screen
   ═══════════════════════════════════════════════════════════════════════════ */

/* Base: switch to Sarabun, kill letter-spacing, open up line-height */
:lang(th) body,
:lang(th) {
  font-family: 'Sarabun', -apple-system, BlinkMacSystemFont, sans-serif;
  letter-spacing: 0;
  line-height: 1.65;
}

/* Reset letter-spacing on every element that can show Thai text */
:lang(th) .page-eyebrow,
:lang(th) .page-title,
:lang(th) .page-desc,
:lang(th) .nav-btn,
:lang(th) .nav-group-label,
:lang(th) .btn,
:lang(th) .badge,
:lang(th) .status-badge,
:lang(th) .section-label,
:lang(th) .form-section-title,
:lang(th) .field,
:lang(th) .field-label,
:lang(th) .field-hint,
:lang(th) .tab-btn,
:lang(th) .quick-action-label,
:lang(th) .quick-action-desc,
:lang(th) .dashboard-welcome-name,
:lang(th) .dashboard-completion-hint,
:lang(th) .fmn-label,
:lang(th) td,
:lang(th) th {
  letter-spacing: 0;
}

/* Bump minimum size for small labels */
:lang(th) .field-hint,
:lang(th) .page-eyebrow,
:lang(th) .nav-group-label,
:lang(th) .fmn-label,
:lang(th) .quick-action-desc,
:lang(th) .dashboard-completion-hint {
  font-size: 13px;
}

:lang(th) .nav-btn {
  font-size: 13px;
}

/* Tables: Thai above-line vowels clip at tight line-heights */
:lang(th) td,
:lang(th) th {
  line-height: 1.7;
}

:lang(th) .eo-table,
:lang(th) .eo-farmer table {
  line-height: 1.7;
}

/* Form labels and hints in farmer portal */
:lang(th) .eo-farmer .field-label {
  font-size: 14px;
}

:lang(th) .eo-farmer .field-hint {
  font-size: 13px;
  line-height: 1.6;
}

/* Eyebrow / uppercase labels: Thai has no uppercase — strip transform and
   letter-spacing so characters aren't distorted */
:lang(th) .page-eyebrow,
:lang(th) .section-eyebrow,
:lang(th) .nav-group-label,
:lang(th) .dashboard-completion-label,
:lang(th) .filter-section-title {
  text-transform: none;
  letter-spacing: 0;
  font-size: 13px;
}

/* Bottom mobile nav labels */
:lang(th) .fmn-label {
  font-size: 10px;
  line-height: 1.3;
}
```

---

## 4. `src/App.tsx` — Three edits

### 4a. Import FarmerMobileNav (near the other farmer component imports, ~line 81)

```tsx
import FarmerNav from './components/farmer/FarmerNav'
import FarmerMobileNav from './components/farmer/FarmerMobileNav'  // ← add
import AdminNav from './components/admin/AdminNav'
```

### 4b. Add a `useEffect` to sync the HTML lang attribute (place it directly after the existing `useEffect` that handles the `public-auth-page` body class)

```tsx
  // Sync the HTML lang attribute so CSS :lang(th) selectors work and
  // screen readers announce the correct language.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
```

### 4c. Wrap the desktop FarmerNav so CSS can hide it on mobile

Find:
```tsx
{showFarmerNav && <FarmerNav lang={lang} page={page} goTo={goTo} />}
```

Replace with:
```tsx
{showFarmerNav && (
  <div className="farmer-nav-topbar">
    <FarmerNav lang={lang} page={page} goTo={goTo} />
  </div>
)}
```

### 4d. Render the mobile bottom nav (add just before the closing `</>` of the return, after all page content — near the existing diagnostic chrome comment)

```tsx
{/* ── Farmer mobile bottom navigation (visible only on mobile ≤768px) ── */}
{showFarmerNav && isFarmerPage && (
  <FarmerMobileNav
    lang={lang}
    page={page}
    goTo={goTo}
    openRequestsCount={farmerReviewRequests.filter(r => r.status === 'open').length}
  />
)}
```

---

## 5. `src/components/farmer/FarmerMobileNav.tsx` — New file

Create this file at the path shown. It has no external dependencies beyond
your existing `types` and `translations` modules.

```tsx
import type { Lang, Page } from '../../types'
import { T } from '../../translations'

function IconHome() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5L11 3l8 7.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V10.5z"/>
      <path d="M8.5 21V13.5h5V21"/>
    </svg>
  )
}

function IconFarm() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20V9.5l8-6.5 8 6.5V20"/>
      <rect x="8.5" y="13" width="5" height="7" rx="0.5"/>
    </svg>
  )
}

function IconBox() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 13V21M4 9v7.5l7 4 7-4V9L11 5 4 9z"/>
      <path d="M18 9l-7 4-7-4"/>
    </svg>
  )
}

function IconInbox() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="16" height="14" rx="1.5"/>
      <path d="M3 13h5l2.5 3.5L13 13h6"/>
    </svg>
  )
}

function IconList() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="14" height="16" rx="1.5"/>
      <path d="M7 9h8M7 12h8M7 15h5"/>
    </svg>
  )
}

interface Props {
  lang: Lang
  page: Page
  goTo: (p: Page) => void
  openRequestsCount?: number
}

export default function FarmerMobileNav({ lang, page, goTo, openRequestsCount = 0 }: Props) {
  const t = T[lang]
  const isTh = lang === 'th'

  const items: { page: Page; label: string; icon: React.ReactNode; badge?: number }[] = [
    {
      page: 'farmer-dashboard',
      label: isTh ? 'หน้าหลัก' : 'Home',
      icon: <IconHome />,
    },
    {
      page: 'farmer-onboarding',
      label: isTh ? 'โปรไฟล์' : 'Profile',
      icon: <IconFarm />,
    },
    {
      page: 'farmer-my-stock',
      label: t.myStock,
      icon: <IconBox />,
    },
    {
      page: 'farmer-requests',
      label: isTh ? 'คำขอ' : 'Requests',
      icon: <IconInbox />,
      badge: openRequestsCount > 0 ? openRequestsCount : undefined,
    },
    {
      page: 'farmer-status',
      label: isTh ? 'รายการ' : 'Activity',
      icon: <IconList />,
    },
  ]

  return (
    <nav className="farmer-mobile-nav" aria-label={isTh ? 'เมนูนำทางเกษตรกร' : 'Farmer navigation'}>
      {items.map(item => (
        <button
          key={item.page}
          className={`fmn-item${page === item.page ? ' fmn-active' : ''}`}
          onClick={() => goTo(item.page)}
          aria-current={page === item.page ? 'page' : undefined}
        >
          <span className="fmn-icon-wrap">
            {item.icon}
            {item.badge !== undefined && (
              <span className="fmn-badge">{item.badge > 9 ? '9+' : item.badge}</span>
            )}
          </span>
          <span className="fmn-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
```

---

## Summary of what each change does

| Change | Effect |
|---|---|
| Sarabun in Google Fonts | Thai text uses a screen-optimised Thai font instead of OS fallback |
| `'Sarabun'` in body font-family | Sarabun activates as the Thai glyph source when Inter has no match |
| `--accent: #C6A24C` | Logo and all active/highlight states render in brand gold, not slate blue |
| `--accent-strong: #A8883A` | Hover states stay in gold family |
| `btn-primary` shadow tint | Button glow matches gold accent |
| `vite.config.ts allowedHosts` | Preview works through Replit/Vercel preview proxies |
| `FarmerMobileNav` component | Fixed 5-tab bottom nav on phones ≤768px with icon, label, badge |
| `.farmer-nav-topbar` wrapper | Lets CSS hide the desktop nav row on mobile without touching FarmerNav |
| Mobile CSS block | Touch targets, full-width buttons, single-column forms, horizontal-scroll tables, safe-area padding |
| `document.documentElement.lang = lang` | Activates CSS `:lang(th)` selectors when user switches language |
| `:lang(th)` CSS block | Kills letter-spacing, boosts line-height, enforces minimum sizes for Thai |

All changes are on the `mobile-improvements` branch of your GitHub repo if you
prefer to merge rather than apply manually.

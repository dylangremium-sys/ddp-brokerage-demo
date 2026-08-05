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

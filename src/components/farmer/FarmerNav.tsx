import type { Lang, Page } from '../../types'
import { T } from '../../translations'

export default function FarmerNav({ lang, page, goTo }: {
  lang: Lang
  page: Page
  goTo: (p: Page) => void
}) {
  return (
    <div className="nav-group">
      <span className="nav-group-label">{T[lang].farmerGroupLabel}</span>
      <button
        className={`nav-btn${page === 'farmer-dashboard' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-dashboard')}
      >{T[lang].navDashboard}</button>
      <button
        className={`nav-btn${page === 'farmer-onboarding' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-onboarding')}
      >{T[lang].buildProfile}</button>
      <button
        className={`nav-btn${page === 'farmer-my-stock' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-my-stock')}
      >{T[lang].myStock}</button>
      <button
        className={`nav-btn${page === 'farmer-status' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-status')}
      >{T[lang].myActivity}</button>
    </div>
  )
}

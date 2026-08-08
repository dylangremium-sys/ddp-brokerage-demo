import type { Lang, Page } from '../../types'
import { T } from '../../translations'

/**
 * evidenceWaiting is `number | null`, and the distinction is load-bearing: null
 * means "not known yet, or the read failed", which must render NO badge rather
 * than a reassuring absence of one. A farmer who is told nothing is waiting when
 * DDP is in fact waiting on them is the failure this badge exists to prevent, so
 * it must not be introduced by the badge itself.
 */
export default function FarmerNav({ lang, page, goTo, evidenceWaiting = null }: {
  lang: Lang
  page: Page
  goTo: (p: Page) => void
  evidenceWaiting?: number | null
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
        className={`nav-btn${page === 'farmer-requests' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-requests')}
      >{T[lang].requestsLabel}</button>
      {/* Evidence sits next to Requests because they are the same kind of thing
          from the farmer's side: something DDP needs from them. It was reachable
          only from the dashboard tile, so a farmer working in My Stock — where
          they would actually go to fix the document — had no route to the
          question they were being asked. */}
      <button
        className={`nav-btn${page === 'farmer-evidence' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-evidence')}
      >
        {T[lang].evidenceLabel}
        {evidenceWaiting !== null && evidenceWaiting > 0 && (
          <span className="requests-badge" style={{ marginLeft: 6 }}>{evidenceWaiting}</span>
        )}
      </button>
      <button
        className={`nav-btn${page === 'farmer-advanced-profile' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-advanced-profile')}
      >{T[lang].advancedProfile}</button>
      <button
        className={`nav-btn${page === 'farmer-status' ? ' nav-active' : ''}`}
        onClick={() => goTo('farmer-status')}
      >{T[lang].myActivity}</button>
    </div>
  )
}

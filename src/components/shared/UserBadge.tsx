import type { UserProfile, UserRole } from '../../services/auth'

/**
 * How each role presents itself in the navbar chip.
 *
 * This was a two-way conditional — `ddp_admin ? 'Admin' : 'Farmer'` — which
 * treated every non-admin as a farmer. The moment W3.1 made `buyer` routable,
 * a buyer signing in would have been shown a **"Farmer"** chip on their own
 * account page: the product asserting something untrue about who someone is,
 * on the one screen where they are looking at their own identity.
 *
 * A lookup rather than a chain, so the next role added is a compile error here
 * (`Record<UserRole, …>` is exhaustive) instead of silently inheriting whatever
 * the fallback happened to be. That is the failure mode this replaces.
 */
const ROLE_PRESENTATION: Record<UserRole, { label: string; className: string }> = {
  ddp_admin: { label: 'Admin', className: 'chip-admin' },
  farmer: { label: 'Farmer', className: 'chip-farmer' },
  buyer: { label: 'Buyer', className: 'chip-buyer' },
  // A pending account cannot reach a surface that renders this badge — the
  // routing decision denies it — but it is a legal role, so it is named rather
  // than left to a fallback.
  pending: { label: 'Pending', className: 'chip-pending' },
}

export default function UserBadge({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => void }) {
  const presentation = ROLE_PRESENTATION[profile.role] ?? { label: 'Account', className: 'chip-farmer' }
  return (
    <div className="user-badge">
      <span className={`user-role-chip ${presentation.className}`}>
        {presentation.label}
      </span>
      <span className="user-email">{profile.displayName || profile.email}</span>
      <button className="nav-reset-btn" onClick={onSignOut}>Sign out</button>
    </div>
  )
}

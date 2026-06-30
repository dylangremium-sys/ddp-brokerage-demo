import type { UserProfile } from '../../services/auth'

export default function UserBadge({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => void }) {
  return (
    <div className="user-badge">
      <span className={`user-role-chip ${profile.role === 'ddp_admin' ? 'chip-admin' : 'chip-farmer'}`}>
        {profile.role === 'ddp_admin' ? 'Admin' : 'Farmer'}
      </span>
      <span className="user-email">{profile.displayName || profile.email}</span>
      <button className="nav-reset-btn" onClick={onSignOut}>Sign out</button>
    </div>
  )
}

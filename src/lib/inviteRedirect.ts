// ─── Where an invitation email sends the supplier ───────────────────────────
//
// WHY THIS EXISTS
//   `inviteUserByEmail` was called with no `redirectTo`, so every invitation
//   link went to whatever the Supabase project's **Site URL** happened to be —
//   a dashboard setting that is invisible from this repository, unversioned,
//   not reviewed, and silently shared by every auth email the project sends.
//
//   That was survivable while invitations led nowhere in particular. It is not
//   survivable now: the link must land on the app that renders the
//   set-password screen, or the invited supplier gets a session on a page that
//   cannot set a password, and the account is unreachable once it expires —
//   exactly the failure the set-password work exists to remove.
//
//   Making the destination an explicit, deployed environment variable means the
//   invite target is reviewable, differs correctly between production and
//   preview, and cannot be changed by someone editing an unrelated setting.
//
// FALLBACK IS DELIBERATE
//   When APP_PUBLIC_URL is unset or unusable this returns undefined, and the
//   caller omits `redirectTo` — restoring exactly the previous Site URL
//   behaviour. A misconfigured variable must not stop invitations being sent;
//   it degrades to what shipped before, never to a broken link.

/** The env var naming the public origin this deployment's invites should reach. */
export const INVITE_REDIRECT_ENV = 'APP_PUBLIC_URL'

/**
 * The absolute URL an invitation link should return to, or undefined to let
 * Supabase fall back to the project's Site URL.
 *
 * Rules, in order:
 *   - unset / blank            -> undefined (Site URL)
 *   - not a parseable URL      -> undefined
 *   - not https, and not a localhost http URL -> undefined
 *   - otherwise                -> origin + pathname, with query and fragment stripped
 *
 * **Query and fragment are stripped deliberately.** Supabase appends the
 * session as a URL *fragment* (`#access_token=…&type=invite`). A `redirectTo`
 * that already carries a fragment would have it overwritten or mangled, and the
 * app would never see the invite parameters it must capture. A redirect target
 * has no business carrying either.
 *
 * **Plain http is refused except on localhost.** An invitation link is a
 * bearer credential; sending it over http would expose it in transit. Refusing
 * degrades to the Site URL, which is the safe direction.
 *
 * Note that Supabase independently requires the result to be on the project's
 * redirect allow-list, and ignores it otherwise. This function decides what to
 * ASK for; the project settings still decide what is permitted.
 */
export function resolveInviteRedirectUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env[INVITE_REDIRECT_ENV]?.trim()
  if (!raw) return undefined

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    return undefined
  }

  return `${url.origin}${url.pathname}`
}

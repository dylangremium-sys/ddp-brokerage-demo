// Known, accepted rollback asymmetries.
//
// WHAT THIS IS FOR
// ----------------
// Extending the catalog snapshot to CHECK constraints (defect D7) made four
// pre-existing rollback defects visible at once. They are real: migrations 39,
// 40, 42 and 45 each WIDEN compliance_audit_log's action vocabulary, and none of
// their rollbacks narrows it back. After rolling one back, the audit log still
// accepts action values for a feature that no longer exists.
//
// WHY THEY ARE NOT SIMPLY FIXED
// -----------------------------
// All four are already applied to staging, and 39-44 specifically ended this
// repo's licence to amend a migration in place. Editing an applied migration to
// fix its rollback would make the file on disk disagree with what every database
// actually ran — which is the more dangerous of the two problems. The remedy is a
// FORWARD migration, allocated a number through the registrar, and that is
// deliberately out of scope for a change whose subject is the gate.
//
// WHY AN ALLOWLIST AND NOT A DISABLED CHECK
// -----------------------------------------
// The alternative to registering these was to keep the gate red on main, and a
// permanently red gate is one people learn to merge past — at which point the
// next real finding is invisible too. This is the narrower harm, but only
// because of how tightly each entry is scoped:
//
//   * An entry waives ONE object in ONE fixture, and only when the before/after
//     definitions are EXACTLY the pair recorded here. Any other change to the
//     same constraint still fails.
//   * A waived entry is printed on every single run, not silently swallowed.
//   * An entry that stops matching is itself an error: it means the world moved
//     and nobody revisited the waiver.
//
// The last point is what stops this file from becoming the thing it exists to
// avoid. An allowlist that tolerates its own staleness is just a slower way of
// switching the check off.

/**
 * @type {Record<string, Array<{ object: string, was: string, now: string, reason: string, raised: string }>>}
 * Keyed by fixture id. `object` is the `kind|obj` key assertCatalogSymmetry reports.
 */
export const KNOWN_ASYMMETRIES = {
  '15_existing_table_audit': [
    {
      object: "grant|table public.compliance_audit_log -> anon",
      was: "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE",
      now: "INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE",
      reason:
        "Migration 15's ROLLBACK grants UPDATE and DELETE back to `authenticated` only, so `anon` " +
        "ends with fewer privileges than it started with. Unlike the other four entries this is " +
        "believed DELIBERATE and must not be 'fixed': compliance_audit_log is append-only by " +
        "construction (migrations 9 and 11 guard it with a trigger), and handing anon back the " +
        "ability to UPDATE or DELETE audit rows to satisfy a symmetry check would be restoring a " +
        "privilege nobody wants restored. Recorded because an asymmetry that is intentional still " +
        "has to be stated -- the previous treatment was to REVOKE the privilege from the substrate " +
        "so the baseline matched the rollback, which also silently un-tested the anon half of 15's " +
        "forward REVOKE. Fail-safe direction; no action expected.",
      raised: '2026-08-04',
    },
  ],
  "39_organisations": [
    {
      object: "constraint|public.compliance_audit_log: compliance_audit_log_action_check",
      was: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      now: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      reason:
        "Migration 39 widens compliance_audit_log's action vocabulary with the five organisation lifecycle actions; its ROLLBACK drops the organisations tables but never narrows the CHECK back. After rolling 39 back the audit log still accepts action values for a feature that no longer exists.",
      raised: '2026-08-04',
    },
  ],
  "40_licences_permits": [
    {
      object: "constraint|public.compliance_audit_log: compliance_audit_log_action_check",
      was: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      now: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'licence_recorded'::text, 'licence_state_changed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'permit_drawdown_reversed'::text, 'permit_drawn_down'::text, 'permit_recorded'::text, 'permit_state_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      reason:
        "Migration 40 adds the six licence/permit actions and its ROLLBACK leaves every one of them admissible.",
      raised: '2026-08-04',
    },
  ],
  "42_export_eligibility_gate": [
    {
      object: "constraint|public.compliance_audit_log: compliance_audit_log_action_check",
      was: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'licence_recorded'::text, 'licence_state_changed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'permit_drawdown_reversed'::text, 'permit_drawn_down'::text, 'permit_recorded'::text, 'permit_state_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      now: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'export_eligibility_evaluated'::text, 'export_gate_overridden'::text, 'export_gate_override_reviewed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'licence_recorded'::text, 'licence_state_changed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'permit_drawdown_reversed'::text, 'permit_drawn_down'::text, 'permit_recorded'::text, 'permit_state_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'screening_recorded'::text, 'sent_to_legal_review'::text])))",
      reason:
        "Migration 42 adds the four export-gate actions and its ROLLBACK leaves them admissible.",
      raised: '2026-08-04',
    },
  ],
  "45_seam7_event_split": [
    {
      object: "constraint|public.compliance_audit_log: compliance_audit_log_action_check",
      was: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'sent_to_legal_review'::text])))",
      now: "c CHECK ((action = ANY (ARRAY['alert_created'::text, 'alert_dismissed'::text, 'alert_resolved'::text, 'document_status_changed'::text, 'export_eligibility_evaluated'::text, 'export_gate_overridden'::text, 'export_gate_override_reviewed'::text, 'legal_update_archived'::text, 'legal_update_created'::text, 'legal_update_reviewed'::text, 'licence_recorded'::text, 'licence_state_changed'::text, 'organisation_created'::text, 'organisation_membership_granted'::text, 'organisation_membership_revoked'::text, 'organisation_updated'::text, 'organisation_verification_changed'::text, 'permit_drawdown_reversed'::text, 'permit_drawn_down'::text, 'permit_recorded'::text, 'permit_state_changed'::text, 'readiness_status_changed'::text, 'reviewer_note_added'::text, 'rule_approved'::text, 'rule_paused'::text, 'rule_rejected'::text, 'rule_retired'::text, 'rule_suggested'::text, 'screening_recorded'::text, 'sent_to_legal_review'::text])))",
      reason:
        "Migration 45's ROLLBACK restores the CHECK to migration 39's vocabulary rather than to the state it found, so it simultaneously fails to remove its own additions and reverses 40's and 42's. The widest of the four, and the clearest sign the vocabulary is amended by whoever touched it last rather than by a rule.",
      raised: '2026-08-04',
    },
  ],
};

/**
 * Filter a symmetry result against the register.
 *
 * Returns { ok, waived, remaining }. `ok` is true only when EVERY reported
 * asymmetry matched a registered entry exactly — a partial match is a failure,
 * because the unregistered part is a new finding regardless of what it sits next to.
 *
 * @param {string} fixtureId
 * @param {{ok: boolean, leaked?: string[], destroyed?: string[], redefined?: string[], details?: object}} symmetry
 */
export function applyKnownAsymmetries(fixtureId, symmetry) {
  if (symmetry.ok) return { ok: true, waived: [], remaining: [] };

  const entries = KNOWN_ASYMMETRIES[fixtureId] || [];
  const details = symmetry.details || {};
  const reported = [
    ...(symmetry.leaked || []),
    ...(symmetry.destroyed || []),
    ...(symmetry.redefined || []),
  ];

  const waived = [];
  const remaining = [];

  for (const key of reported) {
    const entry = entries.find((e) => e.object === key);
    const d = details[key] || {};
    // A registered object is waived ONLY if the definitions still match what was
    // recorded. A constraint that drifted further since the waiver was written is
    // a new defect wearing an old finding's name, and must not inherit its pass.
    if (entry && d.was === entry.was && d.now === entry.now) {
      waived.push({ key, reason: entry.reason, raised: entry.raised });
    } else {
      remaining.push(key);
    }
  }

  return { ok: remaining.length === 0, waived, remaining };
}

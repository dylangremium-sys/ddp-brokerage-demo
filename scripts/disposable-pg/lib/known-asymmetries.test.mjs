import { describe, it, expect } from 'vitest';
import { KNOWN_ASYMMETRIES, applyKnownAsymmetries } from './known-asymmetries.mjs';

const KEY = 'constraint|public.compliance_audit_log: compliance_audit_log_action_check';

// A register that waives too much is worse than no register: it converts a gate
// that found four real defects into one that reports none. Every test here is
// about the BOUNDARY of a waiver, not about the waiver working.
describe('known-asymmetries register', () => {
  it('waives the exact recorded asymmetry', () => {
    const e = KNOWN_ASYMMETRIES['39_organisations'][0];
    const r = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: e.was, now: e.now } },
    });
    expect(r.ok).toBe(true);
    expect(r.waived).toHaveLength(1);
    expect(r.remaining).toEqual([]);
  });

  it('does NOT waive the same object once its definition drifts further', () => {
    // The failure mode that makes allowlists dangerous: a waiver written for one
    // defect silently covering the next one in the same place.
    const e = KNOWN_ASYMMETRIES['39_organisations'][0];
    const drifted = e.now.replace("'alert_created'::text", "'alert_created'::text, 'brand_new_action'::text");
    const r = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: e.was, now: drifted } },
    });
    expect(r.ok).toBe(false);
    expect(r.remaining).toEqual([KEY]);
  });

  it('does NOT waive when the BASELINE moved, even if the end state matches', () => {
    // A changed baseline means the migration now starts from a different world;
    // the recorded triage was about a comparison that no longer exists.
    const e = KNOWN_ASYMMETRIES['39_organisations'][0];
    const r = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY],
      details: { [KEY]: { was: e.was.replace("'alert_created'::text, ", ''), now: e.now } },
    });
    expect(r.ok).toBe(false);
  });

  it('does NOT waive an entry registered against a DIFFERENT fixture', () => {
    const e = KNOWN_ASYMMETRIES['39_organisations'][0];
    const r = applyKnownAsymmetries('44_reservation_ledger', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: e.was, now: e.now } },
    });
    expect(r.ok).toBe(false);
  });

  it('fails when a registered asymmetry appears ALONGSIDE an unregistered one', () => {
    // Partial matches must not pass. A new defect does not become acceptable by
    // arriving in the company of an old one.
    const e = KNOWN_ASYMMETRIES['39_organisations'][0];
    const r = applyKnownAsymmetries('39_organisations', {
      ok: false,
      redefined: [KEY],
      leaked: ['table|public.leftover_table'],
      details: { [KEY]: { was: e.was, now: e.now }, 'table|public.leftover_table': { was: null, now: '' } },
    });
    expect(r.ok).toBe(false);
    expect(r.remaining).toEqual(['table|public.leftover_table']);
    expect(r.waived).toHaveLength(1);
  });

  it('a symmetric result is untouched', () => {
    const r = applyKnownAsymmetries('39_organisations', { ok: true });
    expect(r.ok).toBe(true);
    expect(r.waived).toEqual([]);
  });

  it('every entry carries a reason and a raised date', () => {
    // An undated waiver with no reason is indistinguishable from an accident.
    for (const [fid, entries] of Object.entries(KNOWN_ASYMMETRIES)) {
      for (const e of entries) {
        expect(e.reason, `${fid} reason`).toBeTruthy();
        expect(e.reason.length, `${fid} reason too short to be a triage`).toBeGreaterThan(40);
        expect(e.raised, `${fid} raised`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(e.was, `${fid} was`).toBeTruthy();
        expect(e.now, `${fid} now`).toBeTruthy();
        expect(e.was).not.toBe(e.now);
      }
    }
  });
});

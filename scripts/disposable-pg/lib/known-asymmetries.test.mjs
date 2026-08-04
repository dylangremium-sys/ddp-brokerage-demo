import { describe, it, expect } from 'vitest';
import { KNOWN_ASYMMETRIES, applyKnownAsymmetries } from './known-asymmetries.mjs';

const KEY = 'constraint|public.compliance_audit_log: compliance_audit_log_action_check';

// A register that waives too much is worse than no register: it converts a gate
// that found four real defects into one that reports none. Every test here is
// about the BOUNDARY of a waiver, not about the waiver working.
describe('known-asymmetries register', () => {
  it('waives the exact recorded asymmetry', () => {
    const entry = KNOWN_ASYMMETRIES['39_organisations'][0];
    const result = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: entry.was, now: entry.now } },
    });
    expect(result.ok).toBe(true);
    expect(result.waived).toHaveLength(1);
    expect(result.remaining).toEqual([]);
  });

  it('does NOT waive the same object once its definition drifts further', () => {
    // The failure mode that makes allowlists dangerous: a waiver written for one
    // defect silently covering the next one in the same place.
    const entry = KNOWN_ASYMMETRIES['39_organisations'][0];
    const drifted = entry.now.replace("'alert_created'::text", "'alert_created'::text, 'brand_new_action'::text");
    const result = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: entry.was, now: drifted } },
    });
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([KEY]);
  });

  it('does NOT waive when the BASELINE moved, even if the end state matches', () => {
    // A changed baseline means the migration now starts from a different world;
    // the recorded triage was about a comparison that no longer exists.
    const entry = KNOWN_ASYMMETRIES['39_organisations'][0];
    const result = applyKnownAsymmetries('39_organisations', {
      ok: false, redefined: [KEY],
      details: { [KEY]: { was: entry.was.replace("'alert_created'::text, ", ''), now: entry.now } },
    });
    expect(result.ok).toBe(false);
  });

  it('does NOT waive an entry registered against a DIFFERENT fixture', () => {
    const entry = KNOWN_ASYMMETRIES['39_organisations'][0];
    const result = applyKnownAsymmetries('44_reservation_ledger', {
      ok: false, redefined: [KEY], details: { [KEY]: { was: entry.was, now: entry.now } },
    });
    expect(result.ok).toBe(false);
  });

  it('fails when a registered asymmetry appears ALONGSIDE an unregistered one', () => {
    // Partial matches must not pass. A new defect does not become acceptable by
    // arriving in the company of an old one.
    const entry = KNOWN_ASYMMETRIES['39_organisations'][0];
    const result = applyKnownAsymmetries('39_organisations', {
      ok: false,
      redefined: [KEY],
      leaked: ['table|public.leftover_table'],
      details: { [KEY]: { was: entry.was, now: entry.now }, 'table|public.leftover_table': { was: null, now: '' } },
    });
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual(['table|public.leftover_table']);
    expect(result.waived).toHaveLength(1);
  });

  it('a symmetric result is untouched', () => {
    const result = applyKnownAsymmetries('39_organisations', { ok: true });
    expect(result.ok).toBe(true);
    expect(result.waived).toEqual([]);
  });

  it('every entry carries a reason and a raised date', () => {
    // An undated waiver with no reason is indistinguishable from an accident.
    for (const [fid, entries] of Object.entries(KNOWN_ASYMMETRIES)) {
      for (const registered of entries) {
        expect(registered.reason, `${fid} reason`).toBeTruthy();
        expect(registered.reason.length, `${fid} reason too short to be a triage`).toBeGreaterThan(40);
        expect(registered.raised, `${fid} raised`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(registered.was, `${fid} was`).toBeTruthy();
        expect(registered.now, `${fid} now`).toBeTruthy();
        expect(registered.was).not.toBe(registered.now);
      }
    }
  });
});

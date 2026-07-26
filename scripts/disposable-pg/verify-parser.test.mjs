import { describe, it, expect } from 'vitest';
import { parseVerifyOutput, evaluateVerify } from './lib/verify-parser.mjs';

// A representative slice of real psql NOTICE output.
const SAMPLE = `BEGIN
psql:VERIFY.sql:70: NOTICE:  VERIFY A PASSED: objects exist.
psql:VERIFY.sql:121: NOTICE:  VERIFY B PASSED: no direct DML grants.
psql:VERIFY.sql:230: NOTICE:  VERIFY C PASSED: scope enforced.
ROLLBACK`;

describe('parseVerifyOutput', () => {
  it('extracts unique passed sections in order', () => {
    const p = parseVerifyOutput(SAMPLE);
    expect(p.passed).toEqual(['A', 'B', 'C']);
    expect(p.failed).toEqual([]);
  });
  it('captures a FAILED section (ERROR line)', () => {
    const p = parseVerifyOutput('psql:VERIFY.sql:9: ERROR:  VERIFY D FAILED: mismatch');
    expect(p.failed).toEqual(['D']);
  });
  it('dedupes repeated section mentions', () => {
    const p = parseVerifyOutput('VERIFY A PASSED: x\nVERIFY A PASSED: x again');
    expect(p.passed).toEqual(['A']);
  });
  it('is empty-safe', () => {
    expect(parseVerifyOutput('').passed).toEqual([]);
    expect(parseVerifyOutput(null).passed).toEqual([]);
  });
});

describe('evaluateVerify', () => {
  const expectedSections = ['A', 'B', 'C'];
  it('passes when all expected sections pass and the count matches', () => {
    const r = evaluateVerify(parseVerifyOutput(SAMPLE), { expectedSections, expectedPassCount: 3 });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
  it('fails a doctored all-pass run that skipped a section (count guard)', () => {
    const doctored = 'VERIFY A PASSED: x\nVERIFY B PASSED: y'; // C missing
    const r = evaluateVerify(parseVerifyOutput(doctored), { expectedSections, expectedPassCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/missing\/skipped|count/i);
    expect(r.missing).toContain('C');
  });
  it('fails when a section reports FAILED', () => {
    const failed = SAMPLE.replace('VERIFY C PASSED: scope enforced.', 'VERIFY C FAILED: nope');
    const r = evaluateVerify(parseVerifyOutput(failed), { expectedSections, expectedPassCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/FAILED/);
  });
  it('flags undeclared (drifted) extra sections', () => {
    const drift = SAMPLE + '\npsql:VERIFY.sql:900: NOTICE:  VERIFY Z PASSED: new';
    const r = evaluateVerify(parseVerifyOutput(drift), { expectedSections, expectedPassCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.unexpected).toContain('Z');
  });
  it('flags a vacuous run (no sections passed)', () => {
    const r = evaluateVerify(parseVerifyOutput('nothing here'), { expectedSections, expectedPassCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/vacuous|missing/i);
  });
  it('produces the full 18-section A-R map for migration 24 shape', () => {
    const letters = 'ABCDEFGHIJKLMNOPQR'.split('');
    const text = letters.map((l, i) => `psql:V.sql:${i}: NOTICE:  VERIFY ${l} PASSED: ok`).join('\n');
    const r = evaluateVerify(parseVerifyOutput(text), { expectedSections: letters, expectedPassCount: 18 });
    expect(r.ok).toBe(true);
    expect(r.sections).toHaveLength(18);
    expect(r.sections.every((s) => s.status === 'PASSED')).toBe(true);
  });
});

// verify-parser.mjs — parse VERIFY section outcomes from psql output and enforce
// the completeness / non-vacuity / count guards (brief §8).
//
// A migration's VERIFY script emits, per section, a line like:
//   psql:...VERIFY.sql:70: NOTICE:  VERIFY A PASSED: <description>
// A failing section RAISEs `VERIFY <L> FAILED: ...`, which under ON_ERROR_STOP=1
// psql prints as an ERROR line and aborts. We parse both PASSED and FAILED so a
// doctored all-pass run that skipped sections still fails the count guard.

const PASSED_RE = /VERIFY\s+([A-Z]+)\s+PASSED\b/g;
const FAILED_RE = /VERIFY\s+([A-Z]+)\s+FAILED\b/g;

// Parse combined stdout+stderr text; returns unique passed/failed section labels
// in first-seen order.
export function parseVerifyOutput(text) {
  const src = text == null ? '' : String(text);
  const passed = [];
  const failed = [];
  const seenPass = new Set();
  const seenFail = new Set();
  let m;
  PASSED_RE.lastIndex = 0;
  while ((m = PASSED_RE.exec(src)) !== null) {
    const label = m[1];
    if (!seenPass.has(label)) {
      seenPass.add(label);
      passed.push(label);
    }
  }
  FAILED_RE.lastIndex = 0;
  while ((m = FAILED_RE.exec(src)) !== null) {
    const label = m[1];
    if (!seenFail.has(label)) {
      seenFail.add(label);
      failed.push(label);
    }
  }
  return { passed, failed };
}

// Evaluate a parsed result against the fixture's expectations.
// Returns { ok, problems: string[], passed, failed, missing, unexpected }.
export function evaluateVerify(parsed, { expectedSections = [], expectedPassCount = null } = {}) {
  const problems = [];
  const passedSet = new Set(parsed.passed);
  const failedSet = new Set(parsed.failed);
  const expectedSet = new Set(expectedSections);

  // Any section that reported FAILED is fatal.
  if (parsed.failed.length > 0) {
    problems.push(`VERIFY sections reported FAILED: ${parsed.failed.join(', ')}`);
  }

  // Every expected section must have PASSED (no silently-skipped section).
  const missing = expectedSections.filter((s) => !passedSet.has(s));
  if (missing.length > 0) {
    problems.push(`expected VERIFY sections did not pass (missing/skipped): ${missing.join(', ')}`);
  }

  // Any passed section not in the expected set is a drift signal (surface, fatal:
  // the fixture must be updated deliberately rather than silently absorbing new
  // sections).
  const unexpected = parsed.passed.filter((s) => !expectedSet.has(s));
  if (expectedSections.length > 0 && unexpected.length > 0) {
    problems.push(
      `VERIFY produced sections not declared by the fixture: ${unexpected.join(', ')} ` +
        `(update the fixture's expectedSections deliberately)`,
    );
  }

  // Count guard (guards against a vacuous run).
  if (expectedPassCount != null && parsed.passed.length !== expectedPassCount) {
    problems.push(
      `VERIFY pass count ${parsed.passed.length} != expected ${expectedPassCount}`,
    );
  }

  // Explicit non-vacuity: if we expected any section, at least one must have passed.
  if (expectedSections.length > 0 && parsed.passed.length === 0) {
    problems.push('VERIFY produced no PASSED sections — vacuous run');
  }

  return {
    ok: problems.length === 0,
    problems,
    passed: parsed.passed,
    failed: parsed.failed,
    missing,
    unexpected,
    // Per-section map for evidence.
    sections: expectedSections.map((s) => ({
      section: s,
      status: failedSet.has(s) ? 'FAILED' : passedSet.has(s) ? 'PASSED' : 'MISSING',
    })),
  };
}

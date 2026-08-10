import { describe, it, expect } from 'vitest';
import { buildManifest, verifyRestore, assertPlausible, digest } from './manifest.mjs';

const enc = (s) => new TextEncoder().encode(s);
const OBJ = (bucket, path, body) => ({ bucket, path, bytes: enc(body) });
const META = { takenAt: '2026-08-05T00:00:00.000Z', buckets: ['farmer-documents', 'farmer-photos'] };

describe('buildManifest', () => {
  it('records bucket, path, size and hash for every object', () => {
    const m = buildManifest([OBJ('farmer-photos', 'u1/a.jpg', 'AAA')], META);
    expect(m.objectCount).toBe(1);
    expect(m.totalBytes).toBe(3);
    expect(m.entries[0]).toEqual({
      bucket: 'farmer-photos', path: 'u1/a.jpg', size: 3, sha256: digest(enc('AAA')),
    });
  });

  it('is deterministic — same objects in any order produce an identical manifest', () => {
    // Two runs over unchanged data must be byte-identical, or a diff between
    // days shows listing order rather than real change.
    const a = [OBJ('farmer-photos', 'b.jpg', '2'), OBJ('farmer-documents', 'a.pdf', '1')];
    const m1 = buildManifest(a, META);
    const m2 = buildManifest([...a].reverse(), META);
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });

  it('records a bucket that returned nothing as zero, not as absent', () => {
    // "No entries for farmer-photos" must not be ambiguous between an empty
    // bucket and a listing call that failed and was skipped.
    const m = buildManifest([OBJ('farmer-documents', 'a.pdf', '1')], META);
    expect(m.countsByBucket).toEqual({ 'farmer-documents': 1, 'farmer-photos': 0 });
  });

  it('refuses meta without a timestamp or bucket list', () => {
    expect(() => buildManifest([], {})).toThrow(/takenAt/);
  });
});

describe('verifyRestore — the test that makes it a backup', () => {
  const objects = [OBJ('farmer-documents', 'coa.pdf', 'CERTIFICATE'), OBJ('farmer-photos', 'u1/a.jpg', 'PHOTO')];
  const manifest = buildManifest(objects, META);

  it('passes when every object comes back byte-identical', () => {
    const result = verifyRestore(manifest, objects);
    expect(result.ok).toBe(true);
  });

  it('FALSIFICATION: a missing object is reported as data loss, by name', () => {
    const result = verifyRestore(manifest, [objects[0]]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['farmer-photos/u1/a.jpg']);
    expect(result.diff).toContain('data loss');
  });

  it('FALSIFICATION: same size, different bytes is caught — a length check would not catch it', () => {
    // The failure mode a "did we copy N files" check is blind to: the right
    // number of files, the right sizes, the wrong contents.
    const swapped = [objects[0], OBJ('farmer-photos', 'u1/a.jpg', 'PHOTX')];
    expect(swapped[1].bytes.length).toBe(objects[1].bytes.length);
    const result = verifyRestore(manifest, swapped);
    expect(result.ok).toBe(false);
    expect(result.corrupted).toHaveLength(1);
    expect(result.corrupted[0].object).toBe('farmer-photos/u1/a.jpg');
  });

  it('FALSIFICATION: a truncated download is caught', () => {
    const truncated = [objects[0], OBJ('farmer-photos', 'u1/a.jpg', 'PH')];
    expect(verifyRestore(manifest, truncated).ok).toBe(false);
  });

  it('reports an object the restore invented, separately from one it lost', () => {
    const extra = [...objects, OBJ('farmer-photos', 'u1/ghost.jpg', 'X')];
    const result = verifyRestore(manifest, extra);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(['farmer-photos/u1/ghost.jpg']);
    expect(result.missing).toEqual([]);
  });

  it('an empty restore of an empty backup is fine', () => {
    expect(verifyRestore(buildManifest([], META), []).ok).toBe(true);
  });

  it('a malformed manifest fails closed', () => {
    expect(verifyRestore(null, objects).ok).toBe(false);
    expect(verifyRestore({}, objects).ok).toBe(false);
  });
});

describe('assertPlausible — a backup that silently captured nothing', () => {
  const full = buildManifest(
    [OBJ('farmer-documents', 'a.pdf', '1'), OBJ('farmer-documents', 'b.pdf', '2'),
     OBJ('farmer-photos', 'c.jpg', '3'), OBJ('farmer-photos', 'd.jpg', '4')],
    META,
  );

  it('refuses a zero-object backup unless explicitly allowed', () => {
    // The shape a revoked credential produces: exit 0, valid tiny archive.
    const empty = buildManifest([], META);
    expect(assertPlausible(empty, null).ok).toBe(false);
    expect(assertPlausible(empty, null, { allowEmpty: true }).ok).toBe(true);
  });

  it('accepts a normal run against the previous manifest', () => {
    expect(assertPlausible(full, full).ok).toBe(true);
  });

  it('refuses a run that lost more than half the objects', () => {
    const shrunk = buildManifest([OBJ('farmer-documents', 'a.pdf', '1')], META);
    const r = assertPlausible(shrunk, full);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('fell from 4 to 1');
  });

  it('refuses when a previously-populated bucket goes to zero, even if the total holds', () => {
    // The partial failure a total-count check misses entirely: one bucket's
    // listing failed, another grew, the total looks healthy.
    const lopsided = buildManifest(
      [OBJ('farmer-documents', 'a.pdf', '1'), OBJ('farmer-documents', 'b.pdf', '2'),
       OBJ('farmer-documents', 'e.pdf', '5'), OBJ('farmer-documents', 'f.pdf', '6')],
      META,
    );
    expect(lopsided.objectCount).toBe(full.objectCount);
    const r = assertPlausible(lopsided, full);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('farmer-photos');
  });

  it('a first-ever run with no previous manifest is allowed if non-empty', () => {
    expect(assertPlausible(full, null).ok).toBe(true);
  });
});

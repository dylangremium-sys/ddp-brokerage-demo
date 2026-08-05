import { describe, it, expect } from 'vitest';
import { listBucket, downloadAll } from './storage.mjs';

// A stand-in for the Supabase storage client, built to reproduce the two
// behaviours that make a naive backup silently incomplete:
//
//   1. list() does NOT recurse. Folders come back as entries with a null `id`.
//      Every object in these buckets lives under a uid-prefixed folder, because
//      every storage policy gates on (string_to_array(name,'/'))[1] — so a
//      non-recursive listing finds NOTHING and reports no error.
//   2. list() is capped per call. Past the cap you get a full page and must ask
//      again with an offset; stopping at the first page loses the rest quietly.
//
// Both produce a backup that exits 0 and writes a valid archive.
function fakeClient(tree) {
  return {
    storage: {
      from(bucket) {
        return {
          list(prefix, { limit, offset }) {
            const children = tree[bucket]?.[prefix ?? ''] ?? [];
            return Promise.resolve({ data: children.slice(offset, offset + limit), error: null });
          },
          download(path) {
            const body = tree[bucket]?.__files?.[path];
            if (body === undefined) return Promise.resolve({ data: null, error: { message: 'not found' } });
            return Promise.resolve({ data: { arrayBuffer: async () => new TextEncoder().encode(body).buffer } });
          },
        };
      },
    },
  };
}

const FOLDER = (name) => ({ name, id: null });
const FILE = (name) => ({ name, id: `id-${name}` });

describe('listBucket', () => {
  it('recurses into folders — the uid-prefixed layout every policy assumes', () => {
    const client = fakeClient({
      'farmer-photos': {
        '': [FOLDER('uid-1'), FOLDER('uid-2')],
        'uid-1': [FILE('a.jpg'), FOLDER('2026')],
        'uid-1/2026': [FILE('b.jpg')],
        'uid-2': [FILE('c.jpg')],
      },
    });
    return listBucket(client, 'farmer-photos').then((paths) => {
      expect(paths.sort()).toEqual(['uid-1/2026/b.jpg', 'uid-1/a.jpg', 'uid-2/c.jpg']);
    });
  });

  it('FALSIFICATION: a bucket of only folders is not reported as empty', () => {
    // The exact silent-failure shape: top level has entries, none are files, a
    // non-recursive implementation returns [] and the backup records zero.
    const client = fakeClient({
      'farmer-documents': { '': [FOLDER('uid-1')], 'uid-1': [FILE('coa.pdf')] },
    });
    return listBucket(client, 'farmer-documents').then((paths) => {
      expect(paths).toEqual(['uid-1/coa.pdf']);
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  it('pages past the per-call cap instead of stopping at the first 100', () => {
    const many = Array.from({ length: 250 }, (_, i) => FILE(`f${String(i).padStart(3, '0')}.pdf`));
    const client = fakeClient({ 'farmer-documents': { '': many } });
    return listBucket(client, 'farmer-documents').then((paths) => {
      expect(paths).toHaveLength(250);
    });
  });

  it('an exact multiple of the page size does not lose the last page or loop forever', () => {
    const many = Array.from({ length: 200 }, (_, i) => FILE(`f${i}.pdf`));
    const client = fakeClient({ 'farmer-documents': { '': many } });
    return listBucket(client, 'farmer-documents').then((paths) => expect(paths).toHaveLength(200));
  });

  it('a genuinely empty bucket returns nothing, without error', () => {
    return listBucket(fakeClient({ b: { '': [] } }), 'b').then((paths) => expect(paths).toEqual([]));
  });

  it('a listing error is thrown, never treated as an empty bucket', () => {
    // The difference between "no objects" and "we could not ask" must not be
    // flattened — one is a fine backup, the other is a revoked credential.
    const client = {
      storage: { from: () => ({ list: async () => ({ data: null, error: { message: 'permission denied' } }) }) },
    };
    return expect(listBucket(client, 'farmer-documents')).rejects.toThrow(/permission denied/);
  });
});

describe('downloadAll', () => {
  it('collects every object across every bucket with its bytes', () => {
    const client = fakeClient({
      'farmer-documents': { '': [FOLDER('uid-1')], 'uid-1': [FILE('coa.pdf')], __files: { 'uid-1/coa.pdf': 'CERT' } },
      'farmer-photos': { '': [FILE('a.jpg')], __files: { 'a.jpg': 'PHOTO' } },
    });
    return downloadAll(client, ['farmer-documents', 'farmer-photos']).then((objects) => {
      expect(objects).toHaveLength(2);
      const doc = objects.find((o) => o.bucket === 'farmer-documents');
      expect(doc.path).toBe('uid-1/coa.pdf');
      expect(Buffer.from(doc.bytes).toString()).toBe('CERT');
    });
  });

  it('a failed download aborts the run rather than producing a short backup', () => {
    const client = fakeClient({
      'farmer-documents': { '': [FILE('missing.pdf')], __files: {} },
    });
    return expect(downloadAll(client, ['farmer-documents'])).rejects.toThrow(/downloading/);
  });
});

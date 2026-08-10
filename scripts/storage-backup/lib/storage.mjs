// storage.mjs — the thin layer that actually talks to Supabase Storage.
//
// Kept thin ON PURPOSE. Everything that can be wrong in an interesting way —
// hashing, verification, plausibility, encryption — lives in manifest.mjs and
// archive.mjs, which are pure and unit-tested. What is left here is listing and
// byte transfer, which cannot be meaningfully tested without a real project and
// so must be small enough to read and be sure of.

import { createClient } from '@supabase/supabase-js';

export const DEFAULT_BUCKETS = ['farmer-documents', 'farmer-photos', 'evidence-request-files'];

// Supabase's list() is capped per call and does NOT recurse into folders. Both
// facts are quiet: a bucket with 200 objects returns the first 100 and no error,
// and objects under uid-prefixed folders — which is every object these buckets
// hold, since every storage policy gates on `(string_to_array(name,'/'))[1]` —
// are invisible to a non-recursive listing. A backup built on either mistake
// looks completely successful.
const PAGE = 100;

export function makeClient(url, serviceRoleKey) {
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required');
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

/**
 * Every object path in a bucket, recursing into folders.
 *
 * Supabase represents a folder as an entry with a null `id`; a real object has
 * one. That is the only reliable discriminator — names alone do not tell you.
 */
export async function listBucket(client, bucket, prefix = '') {
  const found = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`listing ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null || entry.id === undefined) {
        found.push(...await listBucket(client, bucket, full));
      } else {
        found.push(full);
      }
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return found;
}

/** Download one object as bytes. Throws rather than returning a partial. */
export async function downloadObject(client, bucket, path) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error) throw new Error(`downloading ${bucket}/${path}: ${error.message}`);
  if (!data) throw new Error(`downloading ${bucket}/${path}: no body returned`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Every object in every named bucket, as {bucket, path, bytes}. */
export async function downloadAll(client, buckets, log = () => undefined) {
  const objects = [];
  for (const bucket of buckets) {
    const paths = await listBucket(client, bucket);
    log(`  ${bucket}: ${paths.length} object(s)`);
    for (const path of paths) {
      objects.push({ bucket, path, bytes: await downloadObject(client, bucket, path) });
    }
  }
  return objects;
}

/**
 * Upload one object. `upsert` is a caller decision, never a default:
 * a restore into a live project that silently overwrote newer files would turn
 * a recovery into a second incident.
 */
export async function uploadObject(client, bucket, path, bytes, { upsert = false } = {}) {
  const { error } = await client.storage.from(bucket).upload(path, bytes, {
    upsert,
    contentType: 'application/octet-stream',
  });
  if (error) throw new Error(`uploading ${bucket}/${path}: ${error.message}`);
}

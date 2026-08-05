// archive.mjs — pack, encrypt, decrypt, unpack.
//
// WHY ENCRYPTED, NOT JUST COPIED
// ------------------------------
// These buckets hold cultivation licences, lab certificates and farm photos —
// identifiable business and personal data under Thailand's PDPA and, for EU
// buyers, GDPR. Migration 37 made all three buckets private on purpose. A backup
// that lands somewhere readable would quietly undo that: the safest copy of your
// data is also the easiest copy to leak, and a backup nobody encrypted is a
// second, unlogged, unversioned production database.
//
// AES-256-GCM with a key derived by scrypt from a passphrase. GCM because it
// authenticates as well as encrypts: a corrupted or tampered archive fails to
// decrypt rather than producing plausible garbage that a restore then writes
// over good data.
//
// Format is deliberately boring and self-describing, so a restore is possible
// with `openssl` and this comment if this repository is unavailable — which is
// exactly the situation a disaster recovery is:
//
//   magic    8 bytes  "DDPBAK01"
//   salt    16 bytes  scrypt salt
//   iv      12 bytes  GCM nonce
//   tag     16 bytes  GCM auth tag
//   body     n bytes  AES-256-GCM ciphertext of the gzipped tar
//
// The passphrase is never written anywhere by this code.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const MAGIC = Buffer.from('DDPBAK01', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// scrypt cost. N=2^15 keeps derivation around a tenth of a second, which is
// irrelevant once a day and materially annoying to anyone brute-forcing a stolen
// archive. maxmem must be raised explicitly or Node refuses this N.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new Error('backup passphrase must be at least 16 characters — this is the only thing protecting farmer identity documents at rest');
  }
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

/**
 * Pack objects into a gzipped tar-like container.
 *
 * A minimal own format rather than real tar: the only consumer is unpack() in
 * this same file, real tar's padding and header quirks buy nothing here, and a
 * format small enough to re-implement from the comment above is worth more in a
 * recovery than one that needs a library.
 *
 *   for each entry: [4-byte BE name length][name utf8][8-byte BE body length][body]
 *
 * @param {Array<{bucket: string, path: string, bytes: Uint8Array}>} objects
 * @param {object} manifest
 */
export function pack(objects, manifest) {
  const chunks = [];
  const put = (name, body) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32BE(nameBuf.length);
    const bodyLen = Buffer.alloc(8);
    bodyLen.writeBigUInt64BE(BigInt(body.length));
    chunks.push(nameLen, nameBuf, bodyLen, Buffer.from(body));
  };

  // The manifest goes in FIRST so a restore can read what it should be about to
  // find before it writes anything anywhere.
  put('MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const o of objects) put(`objects/${o.bucket}/${o.path}`, o.bytes);

  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Inverse of pack(). Returns { manifest, objects }. */
export function unpack(gzipped) {
  const buf = gunzipSync(Buffer.from(gzipped));
  const entries = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('archive truncated in a name length');
    const nameLen = buf.readUInt32BE(off); off += 4;
    if (off + nameLen + 8 > buf.length) throw new Error('archive truncated in a name');
    const name = buf.subarray(off, off + nameLen).toString('utf8'); off += nameLen;
    const bodyLen = Number(buf.readBigUInt64BE(off)); off += 8;
    if (off + bodyLen > buf.length) throw new Error(`archive truncated in the body of ${name}`);
    entries.push({ name, body: buf.subarray(off, off + bodyLen) }); off += bodyLen;
  }

  const manifestEntry = entries.find((e) => e.name === 'MANIFEST.json');
  if (!manifestEntry) throw new Error('archive has no MANIFEST.json — refusing to restore something unverifiable');

  const objects = entries
    .filter((e) => e.name.startsWith('objects/'))
    .map((e) => {
      const rest = e.name.slice('objects/'.length);
      const slash = rest.indexOf('/');
      return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1), bytes: e.body };
    });

  return { manifest: JSON.parse(manifestEntry.body.toString('utf8')), objects };
}

/** Encrypt a packed archive. Returns a Buffer in the DDPBAK01 container format. */
export function encrypt(packed, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(Buffer.from(packed)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/** Decrypt. Throws on a wrong passphrase or ANY tampering (GCM auth failure). */
export function decrypt(container, passphrase) {
  const buf = Buffer.from(container);
  if (buf.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('archive is too small to be a DDPBAK01 container');
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('archive does not start with the DDPBAK01 magic — wrong file?');
  }
  let off = MAGIC.length;
  const salt = buf.subarray(off, off += SALT_LEN);
  const iv = buf.subarray(off, off += IV_LEN);
  const tag = buf.subarray(off, off += TAG_LEN);
  const body = buf.subarray(off);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error(
      'archive failed to decrypt: the passphrase is wrong, or the file has been altered or corrupted. ' +
      'AES-GCM refuses rather than returning damaged data, so this is the check working.',
    );
  }
}

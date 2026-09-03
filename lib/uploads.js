import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath } from './db.js';

/**
 * Photo storage (doc 06 §5 and §7, doc 08 §7).
 *
 * The threat here is a file that is not the image it claims to be — HTML or a
 * script uploaded as `photo.jpg` and later served back to a browser. Three
 * things defend against it, and all three matter:
 *
 *   1. Type comes from the file's own leading bytes, never its extension or the
 *      Content-Type the client asserts. Both of those are attacker-controlled.
 *   2. The stored filename is generated here. No part of the client's filename
 *      survives, so a crafted name cannot escape the directory or shadow
 *      another file.
 *   3. Files live outside Next's public directory and are only ever served
 *      through /api/photo, with a Content-Type from a fixed whitelist and
 *      X-Content-Type-Options: nosniff.
 */

/** Hard cap (doc 08 §6). The phone is expected to compress to ≤1MB first. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Leading-byte signatures (doc 08 §7). WebP is split: 'RIFF' at 0 and 'WEBP' at
 * 8, with a length field between them.
 */
const SIGNATURES = [
  { type: 'jpeg', ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { type: 'png', ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, i) => buffer[i] === byte);
}

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * Identifies an image from its own bytes.
 * @returns {{type: string, ext: string, mime: string}|null} null = not an
 *   image we accept, whatever the filename or declared MIME type says.
 */
export function detectImageType(buffer) {
  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.magic)) {
      return { type: signature.type, ext: signature.ext, mime: signature.mime };
    }
  }
  if (isWebp(buffer)) return { type: 'webp', ext: 'webp', mime: 'image/webp' };
  return null;
}

/**
 * Photos sit beside field.db in the mounted volume (doc 09 §1), so deriving the
 * location from the database path keeps them together — and keeps tests, which
 * point DATABASE_PATH at a scratch directory, from writing into the real one.
 */
export function uploadsDir() {
  return path.join(path.dirname(dbPath()), 'uploads');
}

/**
 * Writes a verified image and returns its relative path.
 * The name is a fresh UUID; nothing the client sent contributes to it.
 */
export function storeUpload(buffer, ext) {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${crypto.randomUUID()}.${ext}`;
  // 'wx' fails rather than overwriting, so a UUID collision can never silently
  // destroy an existing photo.
  fs.writeFileSync(path.join(dir, filename), buffer, { flag: 'wx' });

  return `uploads/${filename}`;
}

/**
 * The only filenames this service produces, and therefore the only ones it will
 * serve. Kept in step with PHOTO_PATH in lib/validation.js, which stops a
 * crafted path entering the database through sync in the first place.
 */
const STORED_NAME = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|jpeg|png|webp)$/;

/**
 * Resolves a client-supplied `path` parameter to a real file, or null.
 *
 * Rejects, in order: anything not shaped `uploads/<uuid>.<ext>`; anything that
 * resolves outside the uploads directory; and symlinks, which would otherwise
 * let a link planted in the directory read an arbitrary file.
 *
 * The pattern alone already forbids traversal — `..` cannot match a UUID — but
 * the resolve check stays as a second, independent barrier.
 */
export function resolveStoredPhoto(requested) {
  if (typeof requested !== 'string' || !requested.startsWith('uploads/')) return null;

  const name = requested.slice('uploads/'.length);
  if (!STORED_NAME.test(name)) return null;

  const dir = path.resolve(uploadsDir());
  const resolved = path.resolve(dir, name);
  if (resolved !== path.join(dir, name)) return null;
  if (!resolved.startsWith(dir + path.sep)) return null;

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null; // excludes symlinks and directories

  return resolved;
}

/** Content-Type from our own extension, via a fixed whitelist. */
export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

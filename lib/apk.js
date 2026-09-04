import fs from 'node:fs';
import path from 'node:path';
import { dbPath } from './db.js';

/**
 * APK distribution (doc 06 §8, doc 09 §3 lapis 3).
 *
 * There is no app store here. Four handsets in a plant get their builds from
 * this server, so this directory is the whole distribution channel, and the
 * failure that matters is an operator installing something that is not the
 * build we shipped.
 *
 * Two rules follow, and both are enforced here rather than trusted:
 *
 *   The filename carries the version and nothing else is consulted. A build
 *   dropped in as `sru-field-0.3.0.apk` *is* version 0.3.0 — there is no
 *   metadata file to drift out of step with the bytes beside it.
 *
 *   The newest is chosen by comparing version numbers, never by mtime or by
 *   sort order. `0.10.0` sorts before `0.9.0` as text, and an accidental
 *   downgrade pushed to every handset is exactly the kind of quiet damage that
 *   is hard to notice and expensive to undo.
 */

/** Beside field.db in the mounted volume (doc 09 §1), same as uploads. */
export function apkDir() {
  return path.join(path.dirname(dbPath()), 'apk');
}

/**
 * The only filename shape accepted, both on upload and when listing.
 *
 * Strict on purpose: this is the one place a name reaches a download the
 * operator will install, so anything unexpected is refused rather than
 * interpreted.
 */
const APK_NAME = /^sru-field-(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.apk$/;

/** ZIP local file header — an APK is a ZIP, and this is what one must start with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Hard cap. A release build is ~70MB; this leaves room without inviting abuse. */
export const MAX_APK_BYTES = 200 * 1024 * 1024;

export function isApk(buffer) {
  if (buffer.length < ZIP_MAGIC.length) return false;
  return ZIP_MAGIC.every((byte, i) => buffer[i] === byte);
}

export function apkFilename(version) {
  return `sru-field-${version}.apk`;
}

/** Parses a version into comparable parts, or null if it is not one. */
export function parseVersion(value) {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(value ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric compare, so 0.10.0 is correctly newer than 0.9.0. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Every build on disk, newest first.
 *
 * Files that do not match the naming rule are ignored rather than reported: the
 * directory is a mounted volume an operator may have copied something into, and
 * one stray file must not break the update check for four handsets.
 */
export function listApks() {
  const dir = apkDir();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && APK_NAME.test(entry.name))
    .map((entry) => {
      const version = APK_NAME.exec(entry.name).slice(1, 4).join('.');
      const stat = fs.statSync(path.join(dir, entry.name));
      return {
        version,
        filename: entry.name,
        bytes: stat.size,
        uploadedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function latestApk() {
  return listApks()[0] ?? null;
}

/**
 * Resolves one build to a real path, or null.
 *
 * Same belt-and-braces shape as resolveStoredPhoto: the pattern already forbids
 * traversal, and the resolve check stays as an independent second barrier.
 * lstat excludes symlinks, which would otherwise let a link planted in the
 * volume stream an arbitrary file to a handset.
 */
export function resolveApk(filename) {
  if (typeof filename !== 'string' || !APK_NAME.test(filename)) return null;

  const dir = path.resolve(apkDir());
  const resolved = path.resolve(dir, filename);
  if (resolved !== path.join(dir, filename)) return null;
  if (!resolved.startsWith(dir + path.sep)) return null;

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  return resolved;
}

/**
 * Writes a verified build.
 *
 * Overwriting an existing version is refused. Replacing 0.3.0 in place would
 * leave some handsets running one 0.3.0 and some another, with nothing to tell
 * them apart — bump the version instead.
 */
export function storeApk(buffer, version) {
  if (!parseVersion(version)) throw new Error('versi tidak valid');

  const dir = apkDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = apkFilename(version);
  fs.writeFileSync(path.join(dir, filename), buffer, { flag: 'wx' });

  return filename;
}

export function deleteApk(filename) {
  const resolved = resolveApk(filename);
  if (!resolved) return false;
  fs.unlinkSync(resolved);
  return true;
}

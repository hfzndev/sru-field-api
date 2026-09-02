#!/usr/bin/env node
/**
 * Writes public/version.json from git history (dok 09 §4, lapis 1).
 *
 * Served at GET /api/version and shown in the admin footer, so the operator can
 * be asked "what does the server say it is" instead of guessing from git log on
 * the host — which reports the checkout, not the image that is actually running.
 *
 * Four things make this file come out empty; all four are guarded elsewhere:
 *   - actions/checkout without fetch-depth: 0   → no tags, no history
 *   - .dockerignore excluding .git              → no repo inside the builder
 *   - builder image without git installed       → every command below fails
 *   - SKIP_GIT_TAG=1                            → never set it
 * This script still emits a usable version if git is unavailable, but it says
 * so in `commit` rather than pretending.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'version.json');
const BASE_VERSION = '0.1.0'; // matches the v0.1.0 tag cut at scaffold time

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function resolveVersion() {
  // v0.1.0-3-gabc1234 → base 0.1.0, 3 commits since the tag
  const described = git(['describe', '--tags', '--long', '--dirty']);
  if (described) {
    const m = described.match(/^v?(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/);
    if (m) {
      const [, major, minor, patch, ahead, commit, dirty] = m;
      return {
        version: `${major}.${minor}.${Number(patch) + Number(ahead)}${dirty ? '-dirty' : ''}`,
        commit,
        source: 'git-describe',
      };
    }
  }

  // Tagged repo but an unparseable description, or no tags at all: fall back to
  // commit count so the number still moves forward with every release.
  const count = git(['rev-list', '--count', 'HEAD']);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (count && sha) {
    const [major, minor] = BASE_VERSION.split('.');
    return { version: `${major}.${minor}.${count}`, commit: sha, source: 'commit-count' };
  }

  return { version: BASE_VERSION, commit: 'nogit', source: 'fallback' };
}

const { version, commit, source } = resolveVersion();
const payload = {
  version,
  buildDate: new Date().toISOString(),
  commit,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`version.json → ${payload.version} (${payload.commit}, via ${source})`);
if (source === 'fallback') {
  console.warn('WARNING: no git metadata available — version is a placeholder. Check .dockerignore/.git and fetch-depth.');
}

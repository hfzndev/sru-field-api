import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * GET /api/version — dok 06 §3.
 * Reports what this *running image* believes it is; the mobile app and the
 * admin footer both read it, and it is the ground truth when a deploy is
 * suspected of not having landed.
 */
export async function GET() {
  try {
    const file = path.resolve(process.cwd(), 'public', 'version.json');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Response.json(payload);
  } catch {
    // Missing version.json means the build skipped scripts/version.js — a real
    // deploy fault, so say so rather than inventing a number.
    return Response.json(
      { error: { code: 'VERSION_UNAVAILABLE', message: 'version.json tidak ditemukan — build tidak lengkap' } },
      { status: 500 },
    );
  }
}

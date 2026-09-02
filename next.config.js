/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker deploy ships the standalone server (dok 09 §2).
  output: 'standalone',

  // better-sqlite3 is a native module: it must never be bundled, or the
  // .node binding is dropped and the container boots with a broken DB layer.
  serverExternalPackages: ['better-sqlite3'],

  // Field app talks to this API with a bearer token, not a browser session,
  // so no CORS is opened here on purpose (dok 08 §8).
  poweredByHeader: false,
};

export default nextConfig;

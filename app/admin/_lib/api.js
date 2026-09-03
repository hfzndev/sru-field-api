'use client';

/**
 * Client-side API access for the admin pages.
 *
 * A 401 means the session cookie has expired or been forged. The API is the
 * real gate — middleware only checks that a cookie is present — so the browser
 * treats any 401 as "sign in again" rather than trying to interpret it.
 */

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/admin/login';
    // Never resolves: the page is navigating away, and letting callers continue
    // would flash an error before the redirect lands.
    return new Promise(() => {});
  }

  let payload = null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Terjadi kesalahan. Coba lagi.');
    error.code = payload?.error?.code;
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }

  return payload;
}

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: (url) => request(url, { method: 'DELETE' }),
};

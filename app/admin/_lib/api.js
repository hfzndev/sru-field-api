'use client';

/**
 * Client-side API access for the admin pages.
 *
 * A 401 means the session cookie has expired or been forged. The API is the
 * real gate — middleware only checks that a cookie is present — so the browser
 * treats any 401 as "sign in again" rather than trying to interpret it.
 */

async function request(url, options = {}) {
  const { json = true, ...init } = options;
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: init.body && json ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  if (response.status === 401 && typeof window !== 'undefined') {
    // A full page load, not a client-side route change: the session is gone, so
    // every cached page state is stale and should be discarded with it.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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
  /**
   * Multipart POST. The Content-Type header is deliberately left unset — the
   * browser has to write it itself so it can include the multipart boundary,
   * and setting it by hand produces a body the server cannot parse.
   */
  postForm: (url, form) => request(url, { method: 'POST', body: form, json: false }),
  put: (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: (url) => request(url, { method: 'DELETE' }),
};

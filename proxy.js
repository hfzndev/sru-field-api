import { NextResponse } from 'next/server';

/**
 * Keeps signed-out visitors off the admin pages (doc 08 §3).
 *
 * Next 16 renamed this file convention from middleware to proxy.
 *
 * This checks only that a session cookie is *present*. Verifying the HMAC needs
 * node:crypto, which is not available in this runtime — so the real
 * gate is every /api/admin/* route, each of which verifies the signature before
 * touching data. A forged cookie gets past this redirect and then fails on the
 * first API call, which the client turns back into a redirect to the login page.
 *
 * In other words: this is a convenience so nobody stares at an empty screen,
 * not a security control.
 */
export default function proxy(request) {
  const { pathname } = request.nextUrl;

  if (pathname === '/admin/login') return NextResponse.next();

  if (!request.cookies.get('admin_session')) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};

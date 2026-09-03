'use client';

import { usePathname } from 'next/navigation';
import Shell from './_components/Shell';

/**
 * The login page is the one admin route without navigation — showing tabs to
 * someone who is not signed in just invites a redirect loop.
 */
export default function AdminLayout({ children }) {
  const pathname = usePathname();
  if (pathname === '/admin/login') return children;
  return <Shell>{children}</Shell>;
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../_lib/api';

/**
 * Navigation shell (doc 03 §4): a bottom tab bar on phones so every tab is in
 * thumb reach, promoted to a top nav from 900px.
 */
const TABS = [
  { href: '/admin', label: 'Dashboard', icon: '📊' },
  { href: '/admin/tanks', label: 'Tangki', icon: '🛢️' },
  { href: '/admin/equipment', label: 'Equipment', icon: '⚙️' },
  { href: '/admin/contractors', label: 'Kontraktor', icon: '🏗️' },
  { href: '/admin/shifts', label: 'Shift', icon: '👷' },
  { href: '/admin/maintenance', label: 'Maintenance', icon: '🔧' },
  { href: '/admin/data', label: 'Data', icon: '🗂️' },
  { href: '/admin/devices', label: 'Devices', icon: '📱' },
];

export default function Shell({ children }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    try {
      await api.post('/api/admin/logout');
    } finally {
      router.replace('/admin/login');
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">SRU Field</span>
        <span className="spacer" />
        <button type="button" className="btn-sm" onClick={logout}>Keluar</button>
      </header>

      <nav className="tabbar" aria-label="Menu admin">
        {TABS.map((tab) => {
          // Exact match for the dashboard, prefix for the rest — otherwise
          // "/admin" would light up on every page.
          const active = tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined}>
              <span className="ico" aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      <main className="content">{children}</main>
    </div>
  );
}

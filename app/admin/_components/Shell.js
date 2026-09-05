'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../_lib/api';
import { ThemeToggle } from './ui';
import {
  Crane,
  Cylinder,
  DeviceMobile,
  FolderOpen,
  Gauge,
  Gear,
  HardHat,
  ICON,
  SignOut,
  Wrench,
} from './icons';

/**
 * Navigation shell (doc 03 §4): a bottom tab bar on phones so every tab is in
 * thumb reach, promoted to a top nav from 900px.
 */
const TABS = [
  { href: '/admin', label: 'Dashboard', Icon: Gauge },
  { href: '/admin/tanks', label: 'Tangki', Icon: Cylinder },
  { href: '/admin/equipment', label: 'Equipment', Icon: Gear },
  { href: '/admin/contractors', label: 'Kontraktor', Icon: Crane },
  { href: '/admin/shifts', label: 'Shift', Icon: HardHat },
  { href: '/admin/maintenance', label: 'Maintenance', Icon: Wrench },
  { href: '/admin/data', label: 'Data', Icon: FolderOpen },
  { href: '/admin/devices', label: 'Devices', Icon: DeviceMobile },
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
      {/* On a phone the tab bar sits between the header and the content in tab
          order, so without this a keyboard user walks all eight tabs first. */}
      <a className="skip-link" href="#konten">Lompat ke konten</a>

      <header className="topbar">
        <span className="brand">
          <span className="mark" aria-hidden="true"><Cylinder size={ICON.tile} /></span>
          SRU Field
        </span>
        <span className="spacer" />
        <ThemeToggle />
        <button type="button" className="btn-sm" onClick={logout}>
          <span className="ico" aria-hidden="true"><SignOut size={ICON.inline} /></span>
          Keluar
        </button>
      </header>

      <nav className="tabbar" aria-label="Menu admin">
        {TABS.map((tab) => {
          // Exact match for the dashboard, prefix for the rest — otherwise
          // "/admin" would light up on every page.
          const active = tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined}>
              <span className="ico" aria-hidden="true"><tab.Icon size={ICON.nav} /></span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      <main className="content" id="konten">{children}</main>
    </div>
  );
}

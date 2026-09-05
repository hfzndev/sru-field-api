import Link from 'next/link';

/**
 * 404. Every dead end needs a way back — a foreman who mistypes a URL or
 * follows a stale bookmark should not have to retype the host.
 */
export const metadata = {
  title: 'Halaman tidak ditemukan',
};

export default function NotFound() {
  return (
    <main className="plain">
      <div className="code">404</div>
      <h1>Halaman tidak ditemukan</h1>
      <p>Alamat ini tidak ada, atau halamannya sudah dipindah. Periksa kembali tautannya.</p>
      <div className="actions">
        <Link className="btn btn-primary" href="/admin">Ke dashboard</Link>
      </div>
    </main>
  );
}

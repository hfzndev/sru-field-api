import Link from 'next/link';

/**
 * Public root. Nothing here is useful to anyone who is not staff, so it says so
 * and points at the panel — it used to be an inline-styled stub that ignored
 * globals.css entirely and rendered in the browser's default font.
 */
export const metadata = {
  title: 'SRU Field API',
};

export default function Home() {
  return (
    <main className="plain">
      <div className="code">SRU Field</div>
      <h1>Layanan internal</h1>
      <p>Halaman ini tidak dipakai. Pengelolaan data lapangan ada di panel admin.</p>
      <div className="actions">
        <Link className="btn btn-primary" href="/admin">Buka panel admin</Link>
      </div>
    </main>
  );
}

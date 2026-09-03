import './globals.css';

export const metadata = {
  title: 'SRU Field API',
  description: 'Backend & admin — SRU Field App (IPAL Sulfur Cilacap)',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled: pinching to read a photo thumbnail or a long note is a
  // legitimate thing to do on a phone, and disabling it fails accessibility.
  maximumScale: 5,
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}

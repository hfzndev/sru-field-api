import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

/*
 * Geist ships as an npm package rather than coming from next/font/google on
 * purpose: the Docker builder stage would otherwise need egress to
 * fonts.gstatic.com, and a font fetch is not a thing a deploy should be able to
 * fail on. See Dockerfile.
 */

export const metadata = {
  title: {
    default: 'SRU Field — Panel Admin',
    template: '%s · SRU Field',
  },
  description: 'Panel pengelolaan data lapangan IPAL Sulfur Cilacap — tangki, equipment, shift, dan perangkat.',
  applicationName: 'SRU Field',
  robots: { index: false, follow: false }, // internal tool, never for search
  openGraph: {
    title: 'SRU Field — Panel Admin',
    description: 'Panel pengelolaan data lapangan IPAL Sulfur Cilacap.',
    siteName: 'SRU Field',
    locale: 'id_ID',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled: pinching to read a photo thumbnail or a long note is a
  // legitimate thing to do on a phone, and disabling it fails accessibility.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f3' },
    { media: '(prefers-color-scheme: dark)', color: '#131416' },
  ],
};

/*
 * Applies the saved theme before first paint. Without it the panel renders
 * light and then snaps to dark, which on a desk in a dim control room is worse
 * than having no dark mode at all. Kept tiny and dependency-free by design.
 */
const NO_FLASH = `try{var t=localStorage.getItem('sru-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    // data-scroll-behavior tells Next the smooth scrolling in globals.css is
    // deliberate, so it suppresses it during route transitions rather than
    // animating every navigation.
    <html
      lang="id"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'CE 2.0 · Network Console',
  description: 'Care Everywhere 2.0 — cloud-native cross-org interoperability',
};

const NAV_LINKS = [
  { href: '/',         label: 'Directory' },
  { href: '/queues',   label: 'Queues' },
  { href: '/roi/new',  label: 'New ROI Request' },
  { href: '/agents',   label: 'Agents' },
  { href: '/portal',   label: 'Portal' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>
        <style>{`
          .nav-link {
            color: var(--color-nav-text);
            font-size: 0.86rem;
            font-weight: 500;
            text-decoration: none;
            padding: 6px 2px;
            border-bottom: 2px solid transparent;
            transition: color var(--transition), border-color var(--transition);
            white-space: nowrap;
          }
          .nav-link:hover {
            color: var(--color-nav-hover);
          }
          .nav-link.portal-link {
            color: #5eead4;
          }
          .nav-link.portal-link:hover {
            color: #99f6e4;
          }
        `}</style>

        <nav
          style={{
            background: 'var(--color-nav-bg)',
            padding: '0 28px',
            display: 'flex',
            alignItems: 'center',
            gap: '28px',
            height: '52px',
            boxShadow: '0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.18)',
            position: 'sticky',
            top: 0,
            zIndex: 100,
          }}
        >
          <span
            style={{
              fontWeight: 800,
              fontSize: '0.95rem',
              letterSpacing: '0.02em',
              color: '#e0e7ff',
              marginRight: '8px',
              whiteSpace: 'nowrap',
            }}
          >
            CE 2.0 · Network Console
          </span>

          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`nav-link${link.label === 'Portal' ? ' portal-link' : ''}`}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <main style={{ maxWidth: '960px', margin: '0 auto', padding: '32px 28px' }}>
          {children}
        </main>
      </body>
    </html>
  );
}

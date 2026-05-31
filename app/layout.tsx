import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'CE 2.0',
  description: 'Care Everywhere 2.0 — cloud-native cross-org interoperability',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f9fafb', color: '#111827' }}>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          a { color: inherit; }
        `}</style>

        <nav
          style={{
            background: '#1e3a5f',
            color: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            gap: '32px',
            height: '52px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        >
          <span style={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '0.02em', color: '#93c5fd' }}>
            CE 2.0
          </span>
        </nav>

        <main style={{ maxWidth: '880px', margin: '0 auto', padding: '32px 24px' }}>{children}</main>
      </body>
    </html>
  );
}

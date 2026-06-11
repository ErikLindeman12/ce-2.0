import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { PersonaProvider } from '@/app/components/PersonaProvider';
import { PersonaNav } from '@/app/components/PersonaNav';

export const metadata: Metadata = {
  title: 'CE 2.0 · Network Console',
  description: 'Care Everywhere 2.0 — cloud-native cross-org interoperability',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>
        <PersonaProvider>
          <PersonaNav />
          <main style={{ maxWidth: '960px', margin: '0 auto', padding: '32px 28px' }}>
            {children}
          </main>
        </PersonaProvider>
      </body>
    </html>
  );
}

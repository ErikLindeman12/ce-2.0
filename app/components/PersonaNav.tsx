'use client';

import Link from 'next/link';
import { usePersona, PersonaGuard, PersonaSwitcher } from '@/app/components/PersonaProvider';

const CONSOLE_NAV_LINKS = [
  { href: '/',        label: 'Directory' },
  { href: '/queues',  label: 'Queues' },
  { href: '/roi/new', label: 'New ROI Request' },
  { href: '/agents',  label: 'Agents' },
] as const;

export function PersonaNav() {
  const { persona, hydrated } = usePersona();
  const isProvider = hydrated && persona.mode === 'provider';

  return (
    <>
      {/* Route guard: fires a redirect effect when provider-mode user hits console routes */}
      <PersonaGuard />

      {isProvider ? (
        /* ---- PROVIDER MODE NAV ---- */
        <nav className="nav-provider">
          <div className="nav-provider-left">
            <span className="nav-provider-title">Provider Portal</span>
            <span className="nav-provider-org">{persona.orgName}</span>
          </div>
          <Link href={`/portal/${persona.orgId}`} className="nav-link-provider">
            Inbox
          </Link>
          <div style={{ marginLeft: 'auto' }}>
            <PersonaSwitcher />
          </div>
        </nav>
      ) : (
        /* ---- CONSOLE MODE NAV ---- */
        <nav className="nav-console">
          <span className="nav-console-brand">CE 2.0 · Network Console</span>
          <div className="nav-console-links">
            {CONSOLE_NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="nav-link-console">
                {link.label}
              </Link>
            ))}
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <PersonaSwitcher />
          </div>
        </nav>
      )}
    </>
  );
}

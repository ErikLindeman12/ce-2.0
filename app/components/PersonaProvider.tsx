'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Persona =
  | { mode: 'console' }
  | { mode: 'provider'; orgId: string; orgName: string };

interface PersonaContextValue {
  persona: Persona;
  setPersona: (p: Persona) => void;
  hydrated: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PersonaContext = createContext<PersonaContextValue>({
  persona: { mode: 'console' },
  setPersona: () => {},
  hydrated: false,
});

const STORAGE_KEY = 'ce2.persona';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PersonaProvider({ children }: { children: React.ReactNode }) {
  const [persona, setPersonaState] = useState<Persona>({ mode: 'console' });
  const [hydrated, setHydrated] = useState(false);

  // Read localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Persona;
        if (parsed.mode === 'console' || parsed.mode === 'provider') {
          setPersonaState(parsed);
        }
      }
    } catch {
      // ignore parse errors
    }
    setHydrated(true);
  }, []);

  const setPersona = useCallback((p: Persona) => {
    setPersonaState(p);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      // ignore
    }
  }, []);

  return (
    <PersonaContext.Provider value={{ persona, setPersona, hydrated }}>
      {children}
    </PersonaContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePersona() {
  return useContext(PersonaContext);
}

// ---------------------------------------------------------------------------
// Guard: redirect provider-mode users away from console routes
// ---------------------------------------------------------------------------

const CONSOLE_ROUTE_PREFIXES = ['/', '/queues', '/roi', '/agents', '/items'];

function isConsoleRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return CONSOLE_ROUTE_PREFIXES.some(
    (prefix) => prefix !== '/' && pathname.startsWith(prefix),
  );
}

/**
 * PersonaGuard — pure side-effect component, no children required.
 * When provider mode is active and the user lands on a console route,
 * it replaces navigation to the provider's portal inbox.
 */
export function PersonaGuard() {
  const { persona, hydrated } = usePersona();
  const pathname = usePathname();
  const router = useRouter();
  const redirectedRef = useRef(false);

  useEffect(() => {
    // Reset the redirect flag when the path changes so a new navigation can
    // trigger a fresh check (e.g. user navigates back via browser button).
    redirectedRef.current = false;
  }, [pathname]);

  useEffect(() => {
    if (!hydrated) return;
    if (persona.mode !== 'provider') return;
    if (!isConsoleRoute(pathname)) return;
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    router.replace(`/portal/${persona.orgId}`);
  }, [hydrated, persona, pathname, router]);

  return null;
}

// ---------------------------------------------------------------------------
// Persona Switcher dropdown
// ---------------------------------------------------------------------------

interface Org {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

export function PersonaSwitcher() {
  const { persona, setPersona, hydrated } = usePersona();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load org list when dropdown opens (once)
  useEffect(() => {
    if (!open || orgsLoaded) return;
    fetch('/api/organizations?q=', { cache: 'no-store' })
      .then((r) => r.json())
      .then((body: { data: Org[] }) => {
        setOrgs(Array.isArray(body.data) ? body.data : []);
        setOrgsLoaded(true);
      })
      .catch(() => setOrgsLoaded(true));
  }, [open, orgsLoaded]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function selectConsole() {
    setPersona({ mode: 'console' });
    setOpen(false);
    router.push('/queues');
  }

  function selectOrg(org: Org) {
    setPersona({ mode: 'provider', orgId: org.id, orgName: org.name });
    setOpen(false);
    router.push(`/portal/${org.id}`);
  }

  if (!hydrated) {
    // SSR / pre-hydration placeholder — same width, no flicker
    return (
      <div
        style={{
          height: '32px',
          width: '220px',
          borderRadius: '6px',
          background: 'rgba(255,255,255,0.06)',
        }}
      />
    );
  }

  const isProvider = persona.mode === 'provider';
  const label = isProvider
    ? `${persona.orgName} · Provider Portal`
    : 'Epic Health System · Network Console';
  const icon = isProvider ? '🌐' : '🏥';

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="persona-switcher-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ fontSize: '1rem' }}>{icon}</span>
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ fontSize: '0.7rem', opacity: 0.7, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div className="persona-dropdown" role="listbox">
          {/* Network Console option */}
          <button
            role="option"
            aria-selected={!isProvider}
            className={`persona-dropdown-item${!isProvider ? ' active' : ''}`}
            onClick={selectConsole}
          >
            <span style={{ fontSize: '1rem' }}>🏥</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>Network Console</div>
              <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>Epic Health System</div>
            </div>
            {!isProvider && <span className="persona-check">✓</span>}
          </button>

          <div className="persona-dropdown-divider">Provider portal as…</div>

          {/* Org list */}
          {!orgsLoaded && (
            <div style={{ padding: '8px 14px', fontSize: '0.8rem', color: 'var(--color-ink-faint)' }}>
              Loading…
            </div>
          )}
          {orgsLoaded && orgs.length === 0 && (
            <div style={{ padding: '8px 14px', fontSize: '0.8rem', color: 'var(--color-ink-faint)' }}>
              No organizations found.
            </div>
          )}
          {orgsLoaded && orgs.map((org) => {
            const selected = isProvider && persona.orgId === org.id;
            return (
              <button
                key={org.id}
                role="option"
                aria-selected={selected}
                className={`persona-dropdown-item${selected ? ' active' : ''}`}
                onClick={() => selectOrg(org)}
              >
                <span style={{ fontSize: '1rem' }}>🌐</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.84rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {org.name}
                  </div>
                  {(org.city || org.state) && (
                    <div style={{ fontSize: '0.72rem', opacity: 0.65 }}>
                      {[org.city, org.state].filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>
                {selected && <span className="persona-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

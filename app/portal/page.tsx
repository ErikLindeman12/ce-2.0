'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePersona } from '@/app/components/PersonaProvider';

interface Org {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

export default function PortalLandingPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { persona, setPersona } = usePersona();
  const router = useRouter();

  useEffect(() => {
    async function fetchOrgs() {
      try {
        const res = await fetch('/api/organizations?q=', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load organizations');
        const body = (await res.json()) as { data: Org[] };
        setOrgs(Array.isArray(body.data) ? body.data : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    void fetchOrgs();
  }, []);

  function handleSelectOrg(org: Org) {
    setPersona({ mode: 'provider', orgId: org.id, orgName: org.name });
    router.push(`/portal/${org.id}`);
  }

  // If already in provider mode, show a "continue as" shortcut at the top
  const continuaOrg =
    persona.mode === 'provider'
      ? { id: persona.orgId, name: persona.orgName }
      : null;

  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '60px 24px',
      }}
    >
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '40px' }}>
        <div
          style={{
            display: 'inline-block',
            padding: '6px 14px',
            background: 'var(--color-portal-bg)',
            borderRadius: '20px',
            fontSize: '0.75rem',
            fontWeight: 700,
            color: 'var(--color-portal)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginBottom: '14px',
          }}
        >
          Provider Portal
        </div>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 800,
            color: 'var(--color-ink)',
            margin: '0 0 10px',
            lineHeight: 1.2,
          }}
        >
          Select your organization
        </h1>
        <p style={{ color: 'var(--color-ink-muted)', margin: 0, fontSize: '0.95rem' }}>
          Choose which organization you are acting as to view and respond to records requests.
        </p>
      </div>

      {/* Continue as current provider-persona */}
      {continuaOrg && (
        <div
          style={{
            width: '100%',
            maxWidth: '560px',
            background: '#f0fdf9',
            border: '1px solid var(--color-portal-subtle)',
            borderRadius: '10px',
            padding: '16px 20px',
            marginBottom: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-portal)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '2px' }}>
              Continue as
            </div>
            <div style={{ fontWeight: 700, color: 'var(--color-ink)' }}>{continuaOrg.name}</div>
          </div>
          <button
            onClick={() => router.push(`/portal/${continuaOrg.id}`)}
            className="portal-offer-banner-btn"
          >
            Open Inbox
          </button>
        </div>
      )}

      {/* Org list */}
      <div style={{ width: '100%', maxWidth: '560px' }}>
        <div className="section-label" style={{ marginBottom: '12px' }}>
          All Organizations
        </div>

        {loading && (
          <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem', padding: '24px 0' }}>
            Loading organizations…
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '16px',
              background: 'var(--color-error-bg)',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              color: 'var(--color-error)',
              fontSize: '0.85rem',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && orgs.length === 0 && (
          <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.9rem', padding: '24px 0' }}>
            No organizations found.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => handleSelectOrg(org)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '16px 20px',
                background: '#fff',
                border: '1px solid var(--color-border)',
                borderRadius: '10px',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: 'var(--shadow-card)',
                transition: 'box-shadow var(--transition), border-color var(--transition)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-portal-subtle)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(13,148,136,0.12)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = 'var(--shadow-card)';
              }}
            >
              <div>
                <div style={{ fontWeight: 700, color: 'var(--color-ink)', fontSize: '0.95rem' }}>
                  {org.name}
                </div>
                {(org.city || org.state) && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-ink-faint)', marginTop: '2px' }}>
                    {[org.city, org.state].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
              <span style={{ color: 'var(--color-portal)', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                Continue as this org →
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

interface Org {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

const LAST_ORG_KEY = 'portal_last_org';

export default function PortalLandingPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastOrg, setLastOrg] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    // Restore last org from localStorage
    try {
      const stored = localStorage.getItem(LAST_ORG_KEY);
      if (stored) {
        setLastOrg(JSON.parse(stored) as { id: string; name: string });
      }
    } catch {
      // ignore
    }

    async function fetchOrgs() {
      try {
        const res = await fetch('/api/organizations?q=', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load organizations');
        // GET /api/organizations returns {data: Org[]}
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
    try {
      localStorage.setItem(LAST_ORG_KEY, JSON.stringify({ id: org.id, name: org.name }));
    } catch {
      // ignore
    }
    window.location.href = `/portal/${org.id}`;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#fafbfc',
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
            background: '#eef2ff',
            borderRadius: '20px',
            fontSize: '0.75rem',
            fontWeight: 700,
            color: '#4f46e5',
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
            color: '#16181d',
            margin: '0 0 10px',
            lineHeight: 1.2,
          }}
        >
          CE 2.0 Network Console
        </h1>
        <p style={{ color: '#6b7280', margin: 0, fontSize: '0.95rem' }}>
          Select your organization to view and respond to records requests.
        </p>
      </div>

      {/* Continue as last org */}
      {lastOrg && (
        <div
          style={{
            width: '100%',
            maxWidth: '560px',
            background: '#eef2ff',
            border: '1px solid #c7d2fe',
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
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#4f46e5', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '2px' }}>
              Continue as
            </div>
            <div style={{ fontWeight: 700, color: '#16181d' }}>{lastOrg.name}</div>
          </div>
          <button
            onClick={() => {
              window.location.href = `/portal/${lastOrg.id}`;
            }}
            style={{
              padding: '8px 18px',
              background: '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: '7px',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Open Inbox
          </button>
        </div>
      )}

      {/* Org list */}
      <div style={{ width: '100%', maxWidth: '560px' }}>
        <div
          style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#6b7280',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: '12px',
          }}
        >
          All Organizations
        </div>

        {loading && (
          <div style={{ color: '#9ca3af', fontSize: '0.9rem', padding: '24px 0' }}>
            Loading organizations…
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '16px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              color: '#dc2626',
              fontSize: '0.85rem',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && orgs.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: '0.9rem', padding: '24px 0' }}>
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
                border: '1px solid #e6e8ee',
                borderRadius: '10px',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                transition: 'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#a5b4fc';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(79,70,229,0.1)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#e6e8ee';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
              }}
            >
              <div>
                <div style={{ fontWeight: 700, color: '#16181d', fontSize: '0.95rem' }}>
                  {org.name}
                </div>
                {(org.city || org.state) && (
                  <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: '2px' }}>
                    {[org.city, org.state].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
              <span style={{ color: '#4f46e5', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                View Inbox →
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

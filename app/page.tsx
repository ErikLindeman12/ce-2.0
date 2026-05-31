'use client';

import { useEffect, useState } from 'react';
import type { Org } from '@/lib/types';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(false);
  const [sentFor, setSentFor] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  async function runSearch(q: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const body = (await res.json()) as { data: Org[] };
      setOrgs(body.data);
    } finally {
      setLoading(false);
    }
  }

  // Initial load + debounced search on each keystroke.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  async function sendReferral(org: Org) {
    setSending(org.id);
    try {
      const res = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toOrgId: org.id,
          toOrgName: org.name,
          patient: { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1985-04-12' },
          request: { dataType: 'labs', priority: 'routine', notes: 'Demo referral from portal' },
        }),
      });
      const body = (await res.json()) as { referralId?: string };
      setSentFor((prev) => ({ ...prev, [org.id]: body.referralId ?? 'sent' }));
    } finally {
      setSending(null);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 6px' }}>Organization Directory</h1>
      <p style={{ color: '#6b7280', marginTop: 0, marginBottom: '24px' }}>
        Search connected organizations and send a referral.
      </p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, slug, or data type (e.g. imaging)…"
        style={{
          width: '100%',
          padding: '12px 14px',
          border: '1px solid #d1d5db',
          borderRadius: '8px',
          fontSize: '1rem',
          marginBottom: '20px',
        }}
      />

      {loading && <p style={{ color: '#9ca3af', fontSize: '0.85rem' }}>Searching…</p>}
      {!loading && orgs.length === 0 && (
        <p style={{ color: '#9ca3af' }}>No organizations match “{query}”.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {orgs.map((org) => (
          <div
            key={org.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '16px',
              padding: '16px 20px',
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: '1rem' }}>{org.name}</div>
              <div style={{ color: '#6b7280', fontSize: '0.82rem', marginTop: '2px' }}>
                {org.tenantSlug} · {org.capabilities.dataTypes.join(', ')}
              </div>
            </div>

            {sentFor[org.id] ? (
              <span style={{ color: '#059669', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                ✓ Referral sent
              </span>
            ) : (
              <button
                onClick={() => sendReferral(org)}
                disabled={sending === org.id}
                style={{
                  padding: '8px 16px',
                  background: sending === org.id ? '#93c5fd' : '#1e3a5f',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: sending === org.id ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {sending === org.id ? 'Sending…' : 'Send referral'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

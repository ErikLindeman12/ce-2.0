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
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: '0 0 4px', color: 'var(--color-ink)' }}>
        Organization Directory
      </h1>
      <p style={{ color: 'var(--color-ink-muted)', marginTop: 0, marginBottom: '24px', fontSize: '0.88rem' }}>
        Search connected organizations and send a referral.
      </p>

      <input
        type="text"
        className="input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, slug, or data type (e.g. imaging)…"
        style={{ marginBottom: '20px' }}
      />

      {loading && <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.84rem' }}>Searching…</p>}
      {!loading && orgs.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 32px' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '8px' }}>🏥</div>
          <p style={{ color: 'var(--color-ink-muted)', margin: 0, fontWeight: 600 }}>
            {query ? `No organizations match "${query}".` : 'No organizations yet.'}
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {orgs.map((org) => (
          <div
            key={org.id}
            className="card"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{org.name}</div>
              <div style={{ color: 'var(--color-ink-muted)', fontSize: '0.80rem', marginTop: '2px' }}>
                {org.tenantSlug} · {org.capabilities.dataTypes.join(', ')}
              </div>
            </div>

            {sentFor[org.id] ? (
              <span className="badge badge-success" style={{ whiteSpace: 'nowrap' }}>
                ✓ Referral sent
              </span>
            ) : (
              <button
                onClick={() => void sendReferral(org)}
                disabled={sending === org.id}
                className="btn btn-primary"
                style={{ opacity: sending === org.id ? 0.6 : 1 }}
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

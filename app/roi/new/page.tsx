'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dob: string;
  mrn: string;
}

interface OrgContact {
  fax?: string;
  email?: string;
  phone?: string;
  preferred_channel?: string;
}

interface OrgResult {
  id: string;
  name: string;
  contact?: OrgContact;
  // legacy fields from existing org type
  tenantSlug?: string;
  capabilities?: { channels?: string[] };
}

type OutboundChannel = 'auto' | 'fax' | 'email' | 'sms' | 'voice';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RoiNewPage() {
  const router = useRouter();

  // Patient selection
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [patientsError, setPatientsError] = useState<string | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState('');

  // Org search
  const [orgQuery, setOrgQuery] = useState('');
  const [orgs, setOrgs] = useState<OrgResult[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<OrgResult | null>(null);

  // Form fields
  const [recordsRequested, setRecordsRequested] = useState('');
  const [channel, setChannel] = useState<OutboundChannel>('auto');

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Load patients
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/patients', { cache: 'no-store' });
        if (!res.ok) {
          setPatientsError('Could not load patients');
          return;
        }
        const body = (await res.json()) as
          | { data: Patient[] }
          | Patient[]
          | { data: Array<{ id: string; first_name: string; last_name: string; dob: string; mrn: string }> }
          | Array<{ id: string; first_name: string; last_name: string; dob: string; mrn: string }>;

        // Normalize snake_case or camelCase
        const raw = Array.isArray(body)
          ? body
          : (body as { data: unknown[] }).data ?? [];

        const normalized: Patient[] = raw.map((p) => {
          const r = p as Record<string, string>;
          return {
            id: r.id,
            firstName: r.firstName ?? r.first_name,
            lastName: r.lastName ?? r.last_name,
            dob: r.dob,
            mrn: r.mrn,
          };
        });
        setPatients(normalized);
      } catch (e) {
        setPatientsError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setPatientsLoading(false);
      }
    }
    void load();
  }, []);

  // ---------------------------------------------------------------------------
  // Debounced org search (reuses GET /api/organizations?q=)
  // ---------------------------------------------------------------------------

  const searchOrgs = useCallback(async (q: string) => {
    setOrgsLoading(true);
    try {
      const res = await fetch(`/api/organizations?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const body = (await res.json()) as { data: OrgResult[] } | OrgResult[];
      const list = Array.isArray(body) ? body : (body as { data: OrgResult[] }).data ?? [];
      setOrgs(list);
    } finally {
      setOrgsLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void searchOrgs(orgQuery), 250);
    return () => clearTimeout(t);
  }, [orgQuery, searchOrgs]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatientId || !selectedOrg || !recordsRequested.trim()) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/roi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: selectedPatientId,
          orgId: selectedOrg.id,
          recordsRequested: recordsRequested.trim(),
          ...(channel !== 'auto' ? { channel } : {}),
        }),
      });

      const body = (await res.json()) as {
        error?: string;
        workItemId?: string;
        itemId?: string;  // actual API returns itemId
        status?: string;
      };

      if (!res.ok) {
        setSubmitError(body.error ?? 'Failed to create ROI request');
        return;
      }

      // The API contract says workItemId; actual route returns itemId
      const itemId = body.workItemId ?? body.itemId;
      if (itemId) {
        router.push(`/items/${itemId}`);
      } else {
        setSubmitError('Created but no item ID returned');
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canSubmit = !!selectedPatientId && !!selectedOrg && !!recordsRequested.trim() && !submitting;

  return (
    <div style={{ maxWidth: '620px' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 6px' }}>
        Compose ROI Request
      </h1>
      <p style={{ color: '#6b7280', marginTop: 0, marginBottom: '28px' }}>
        Request records from an external organization on behalf of a patient.
      </p>

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Patient picker */}
        <div style={fieldGroup}>
          <label style={labelStyle}>Patient</label>
          {patientsError ? (
            <div style={{ color: '#dc2626', fontSize: '0.82rem' }}>{patientsError}</div>
          ) : patientsLoading ? (
            <div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Loading patients…</div>
          ) : (
            <select
              value={selectedPatientId}
              onChange={(e) => setSelectedPatientId(e.target.value)}
              required
              style={selectStyle}
            >
              <option value="">Select a patient…</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.firstName} {p.lastName} — DOB {p.dob} — MRN {p.mrn}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Org picker */}
        <div style={fieldGroup}>
          <label style={labelStyle}>Organization</label>
          {selectedOrg ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: '#f0fdf4',
              border: '1px solid #6ee7b7',
              borderRadius: '8px',
            }}>
              <div>
                <div style={{ fontWeight: 700 }}>{selectedOrg.name}</div>
                {selectedOrg.contact && (
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '2px' }}>
                    {selectedOrg.contact.fax && `Fax: ${selectedOrg.contact.fax}`}
                    {selectedOrg.contact.email && ` · Email: ${selectedOrg.contact.email}`}
                    {selectedOrg.contact.preferred_channel && ` · Preferred: ${selectedOrg.contact.preferred_channel}`}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setSelectedOrg(null); setOrgQuery(''); }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  textDecoration: 'underline',
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={orgQuery}
                onChange={(e) => setOrgQuery(e.target.value)}
                placeholder="Search by org name…"
                style={inputStyle}
              />
              {orgsLoading && (
                <div style={{ color: '#9ca3af', fontSize: '0.78rem', marginTop: '4px' }}>Searching…</div>
              )}
              {!orgsLoading && orgs.length > 0 && (
                <div style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  marginTop: '6px',
                  maxHeight: '220px',
                  overflowY: 'auto',
                  background: '#fff',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                }}>
                  {orgs.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => { setSelectedOrg(org); setOrgQuery(''); }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 14px',
                        background: 'none',
                        border: 'none',
                        borderBottom: '1px solid #f3f4f6',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{org.name}</span>
                      {org.contact?.preferred_channel && (
                        <span style={{ color: '#6b7280', marginLeft: '8px', fontSize: '0.75rem' }}>
                          ({org.contact.preferred_channel})
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {!orgsLoading && orgQuery && orgs.length === 0 && (
                <div style={{ color: '#9ca3af', fontSize: '0.82rem', marginTop: '4px' }}>
                  No organizations match &quot;{orgQuery}&quot;.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Records requested */}
        <div style={fieldGroup}>
          <label style={labelStyle}>Records Requested</label>
          <textarea
            value={recordsRequested}
            onChange={(e) => setRecordsRequested(e.target.value)}
            placeholder="Describe the records needed (e.g. cardiology notes from Jan 2024, radiology report, medication list…)"
            required
            rows={4}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        {/* Channel override */}
        <div style={fieldGroup}>
          <label style={labelStyle}>Channel Override</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as OutboundChannel)}
            style={selectStyle}
          >
            <option value="auto">Auto (use org preferred)</option>
            <option value="fax">Fax</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="voice">Voice</option>
          </select>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '4px' }}>
            Leave as Auto to use the org&apos;s preferred channel.
          </div>
        </div>

        {/* Error */}
        {submitError && (
          <div style={{
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            borderRadius: '8px',
            padding: '10px 16px',
            color: '#991b1b',
            fontSize: '0.85rem',
          }}>
            {submitError}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            padding: '12px 24px',
            background: canSubmit ? '#1e3a5f' : '#d1d5db',
            color: canSubmit ? '#fff' : '#9ca3af',
            border: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 700,
            cursor: canSubmit ? 'pointer' : 'default',
            alignSelf: 'flex-start',
          }}
        >
          {submitting ? 'Sending request…' : 'Send ROI Request'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const fieldGroup: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.82rem',
  fontWeight: 700,
  color: '#374151',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  width: '100%',
};

const selectStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '0.9rem',
  background: '#fff',
  width: '100%',
  fontFamily: 'inherit',
};

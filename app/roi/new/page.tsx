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
  tenantSlug?: string;
  capabilities?: { channels?: string[] };
}

type OutboundChannel = 'fax' | 'email' | 'sms' | 'voice' | 'portal';
type ChannelOverride = 'auto' | OutboundChannel;

const WAIT_OPTIONS = [10, 20, 30, 60] as const;
type WaitSeconds = (typeof WAIT_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

const CHANNEL_ICONS: Record<string, string> = {
  fax:    '📠',
  email:  '✉️',
  sms:    '💬',
  voice:  '📞',
  portal: '🌐',
};

const CHANNEL_LABELS: Record<string, string> = {
  fax:    'Fax',
  email:  'Email',
  sms:    'SMS',
  voice:  'Voice',
  portal: 'In-app',
};

/** Mirrors buildChannelPlan from lib/outbound.ts */
function buildClientChannelPlan(
  org: OrgResult | null,
  override: ChannelOverride,
): OutboundChannel[] {
  if (!org) return [];
  const contact = org.contact ?? {};
  const preferred = (contact.preferred_channel ?? 'fax') as OutboundChannel;

  if (preferred === 'portal') return ['portal'];

  const available: OutboundChannel[] = [];
  if (contact.fax)   available.push('fax');
  if (contact.email) available.push('email');
  if (contact.phone) available.push('sms');
  if (contact.phone) available.push('voice');

  if (override !== 'auto') {
    const rest = available.filter((c) => c !== override);
    return [override, ...rest];
  }

  const rest = available.filter((c) => c !== preferred);
  return [preferred, ...rest];
}

// ---------------------------------------------------------------------------
// Client-side document preview (mirrors renderOutboundDocument fax layout)
// ---------------------------------------------------------------------------

function buildDocumentPreview(
  channel: OutboundChannel,
  patient: Patient | null,
  org: OrgResult | null,
  recordsRequested: string,
  waitSeconds: number,
): string {
  if (!patient || !org) return '';

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const itemRef = 'ROI-????????';  // placeholder before creation

  if (channel === 'fax') {
    return [
      '═══════════════════════════════════════════════',
      '         *** FACSIMILE COVER SHEET ***          ',
      '═══════════════════════════════════════════════',
      '',
      `TO:      ${org.name}`,
      `FAX:     ${org.contact?.fax ?? '(on file)'}`,
      `FROM:    Epic Health System — ROI Coordinator`,
      `DATE:    ${today}`,
      `RE:      Records Request — ${patient.firstName} ${patient.lastName}`,
      `PAGES:   1 (cover sheet only)`,
      `REF:     ${itemRef}`,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'CONFIDENTIALITY NOTICE',
      'This facsimile contains protected health information',
      'intended solely for the named recipient. If received',
      'in error, please destroy and notify the sender.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'RECORDS REQUEST',
      '',
      `Patient Name:   ${patient.firstName} ${patient.lastName}`,
      `Date of Birth:  ${patient.dob}`,
      `MRN:            ${patient.mrn}`,
      '',
      'Records Requested:',
      `  ${recordsRequested || '(specify records above)'}`,
      '',
      'Authorization Statement:',
      '  The patient has authorized release of the above',
      '  records pursuant to applicable HIPAA regulations.',
      '',
      `Please respond by: ${waitSeconds}s from receipt`,
      `Reference Number:  ${itemRef}`,
      '',
      '═══════════════════════════════════════════════',
    ].join('\n');
  }

  if (channel === 'email') {
    return [
      `Subject: Records Request — ${patient.firstName} ${patient.lastName} (ref ${itemRef})`,
      '',
      `Dear ${org.name} Health Information Team,`,
      '',
      `We are writing to request medical records for the following patient:`,
      '',
      `  Name:    ${patient.firstName} ${patient.lastName}`,
      `  DOB:     ${patient.dob}`,
      `  MRN:     ${patient.mrn}`,
      '',
      `Records requested: ${recordsRequested || '(specify above)'}`,
      '',
      `Please respond within ${waitSeconds} seconds (system-assisted request).`,
      `Reference number: ${itemRef}`,
      '',
      'Thank you for your prompt attention.',
      '',
      'Epic Health System — ROI Coordinator',
    ].join('\n');
  }

  if (channel === 'sms') {
    return `Records request for ${patient.firstName} ${patient.lastName} (DOB ${patient.dob}). Ref: ${itemRef}. Please call back to fulfill. Thank you — Epic Health System.`.slice(0, 240);
  }

  if (channel === 'voice') {
    return [
      'VOICE CALL SCRIPT',
      '─────────────────',
      `"Hello, this is the Epic Health System records`,
      ` coordination team calling for ${org.name}.`,
      '',
      ` We are requesting medical records for patient`,
      ` ${patient.firstName} ${patient.lastName},`,
      ` date of birth ${patient.dob}.`,
      '',
      ` Our reference number is ${itemRef}.`,
      ` Please return our call or fax records to us.`,
      ` Thank you and have a great day."`,
    ].join('\n');
  }

  if (channel === 'portal') {
    return [
      'PORTAL DELIVERY',
      '───────────────',
      `This request will be delivered directly to`,
      `${org.name} via the secure provider portal.`,
      '',
      `Patient: ${patient.firstName} ${patient.lastName}`,
      `DOB:     ${patient.dob}`,
      `MRN:     ${patient.mrn}`,
      '',
      `Records: ${recordsRequested || '(specify above)'}`,
      '',
      `Ref: ${itemRef}`,
      '',
      `No fax required — the organization will respond`,
      `in-app. There is no automatic chase timeout.`,
    ].join('\n');
  }

  return '';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PatientCard({ patient }: { patient: Patient }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        background: 'var(--color-accent-light)',
        border: '1.5px solid var(--color-accent-subtle)',
        borderRadius: 'var(--radius)',
        marginTop: '6px',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-ink)' }}>
        {patient.firstName} {patient.lastName}
      </div>
      <div style={{ fontSize: '0.80rem', color: 'var(--color-ink-muted)', marginTop: '3px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <span>DOB: {patient.dob}</span>
        <span>MRN: {patient.mrn}</span>
      </div>
    </div>
  );
}

function OrgCapabilityCard({
  org,
  plan,
  override,
}: {
  org: OrgResult;
  plan: OutboundChannel[];
  override: ChannelOverride;
}) {
  const contact = org.contact ?? {};
  const preferred = (contact.preferred_channel ?? 'fax') as OutboundChannel;
  const isPortal = preferred === 'portal';

  const channelPresence: { ch: OutboundChannel; label: string }[] = [];
  if (contact.fax)   channelPresence.push({ ch: 'fax',   label: contact.fax });
  if (contact.email) channelPresence.push({ ch: 'email', label: contact.email });
  if (contact.phone) channelPresence.push({ ch: 'sms',   label: contact.phone });
  if (contact.phone) channelPresence.push({ ch: 'voice', label: contact.phone });
  if (isPortal)      channelPresence.push({ ch: 'portal', label: 'In-app' });

  return (
    <div
      style={{
        padding: '14px 16px',
        background: isPortal ? 'var(--color-portal-bg)' : '#f0fdf4',
        border: `1.5px solid ${isPortal ? 'var(--color-portal-subtle)' : '#6ee7b7'}`,
        borderRadius: 'var(--radius)',
        marginTop: '6px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{org.name}</div>
        {isPortal && (
          <span
            className="badge badge-portal"
            style={{ fontSize: '0.72rem' }}
          >
            🌐 On network — delivered in-app
          </span>
        )}
      </div>

      {/* Channel chips */}
      {channelPresence.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
          {channelPresence.map(({ ch }) => {
            const isPreferred = ch === preferred || (isPortal && ch === 'portal');
            const isInPlan = override === 'auto' ? plan.includes(ch) : override === ch;
            return (
              <span
                key={ch}
                className={`chip${isPreferred ? ' preferred' : ''}${ch === 'portal' ? ' portal-chip' : ''}`}
              >
                {CHANNEL_ICONS[ch]} {CHANNEL_LABELS[ch]}
                {isPreferred && <span style={{ marginLeft: '3px' }}>★</span>}
                {!isInPlan && !isPreferred && (
                  <span style={{ opacity: 0.5, marginLeft: '2px', fontSize: '0.65rem' }}>skipped</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {isPortal && (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-portal)', marginTop: '2px' }}>
          Delivered in-app — no fax required. No timeout chase.
        </div>
      )}
    </div>
  );
}

function ChannelPlanStepper({
  plan,
  waitSeconds,
}: {
  plan: OutboundChannel[];
  waitSeconds: number;
}) {
  if (plan.length === 0) return null;

  return (
    <div>
      <div className="section-label" style={{ marginBottom: '8px' }}>Channel Plan</div>
      <div className="stepper">
        {plan.map((ch, i) => (
          <span key={ch} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span className="stepper-step" style={{ fontSize: '0.80rem' }}>
              <span>{i + 1}</span>
              <span>{CHANNEL_ICONS[ch]}</span>
              <span>{CHANNEL_LABELS[ch]}</span>
            </span>
            {i < plan.length - 1 && (
              <span className="stepper-arrow">
                &nbsp;→ wait {waitSeconds}s →&nbsp;
              </span>
            )}
          </span>
        ))}
      </div>
      {plan.length === 1 && plan[0] === 'portal' && (
        <div style={{ fontSize: '0.77rem', color: 'var(--color-portal)', marginTop: '6px' }}>
          Portal orgs receive a single in-app delivery with no escalation chain.
        </div>
      )}
    </div>
  );
}

function DocumentPreview({
  channel,
  patient,
  org,
  recordsRequested,
  waitSeconds,
}: {
  channel: OutboundChannel;
  patient: Patient | null;
  org: OrgResult | null;
  recordsRequested: string;
  waitSeconds: number;
}) {
  const text = buildDocumentPreview(channel, patient, org, recordsRequested, waitSeconds);

  if (!text) {
    return (
      <div
        style={{
          background: '#f5f6f9',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius)',
          padding: '24px',
          color: 'var(--color-ink-faint)',
          fontSize: '0.84rem',
          textAlign: 'center',
        }}
      >
        Select a patient and organization to see a document preview.
      </div>
    );
  }

  return (
    <div>
      <div className="section-label" style={{ marginBottom: '8px' }}>
        Preview — {CHANNEL_ICONS[channel]} {CHANNEL_LABELS[channel]}
        <span style={{ fontWeight: 400, marginLeft: '8px', textTransform: 'none', letterSpacing: 0 }}>
          (client-side approximation)
        </span>
      </div>
      <div className="card-paper" style={{ fontSize: '0.77rem', lineHeight: 1.65, maxHeight: '340px', overflowY: 'auto' }}>
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
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
  const [channelOverride, setChannelOverride] = useState<ChannelOverride>('auto');
  const [waitSeconds, setWaitSeconds] = useState<WaitSeconds>(30);

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
        if (!res.ok) { setPatientsError('Could not load patients'); return; }
        const body = (await res.json()) as
          | { data: Array<Record<string, string>> }
          | Array<Record<string, string>>;
        const raw = Array.isArray(body) ? body : ((body as { data: Array<Record<string, string>> }).data ?? []);
        const normalized: Patient[] = raw.map((p) => ({
          id: p.id,
          firstName: p.firstName ?? p.first_name,
          lastName: p.lastName ?? p.last_name,
          dob: p.dob,
          mrn: p.mrn,
        }));
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
  // Debounced org search
  // ---------------------------------------------------------------------------

  const searchOrgs = useCallback(async (q: string) => {
    setOrgsLoading(true);
    try {
      const res = await fetch(`/api/organizations?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const body = (await res.json()) as { data: OrgResult[] } | OrgResult[];
      const list = Array.isArray(body) ? body : ((body as { data: OrgResult[] }).data ?? []);
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
  // Derived state
  // ---------------------------------------------------------------------------

  const selectedPatient = patients.find((p) => p.id === selectedPatientId) ?? null;
  const channelPlan = buildClientChannelPlan(selectedOrg, channelOverride);
  const previewChannel = channelPlan[0] ?? 'fax';

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
          waitSeconds,
          ...(channelOverride !== 'auto' ? { channel: channelOverride } : {}),
        }),
      });
      const body = (await res.json()) as { error?: string; data?: { workItemId?: string }; workItemId?: string; itemId?: string };
      if (!res.ok) { setSubmitError(body.error ?? 'Failed to create ROI request'); return; }
      const itemId = body.data?.workItemId ?? body.workItemId ?? body.itemId;
      if (itemId) { router.push(`/items/${itemId}`); }
      else { setSubmitError('Created but no item ID returned'); }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !!selectedPatientId && !!selectedOrg && !!recordsRequested.trim() && !submitting;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: '0 0 4px', color: 'var(--color-ink)' }}>
        Compose ROI Request
      </h1>
      <p style={{ color: 'var(--color-ink-muted)', marginTop: 0, marginBottom: '28px', fontSize: '0.88rem' }}>
        Request records from an external organization on behalf of a patient.
      </p>

      {/* Two-column layout: form left, preview right */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px', alignItems: 'start' }}>

        {/* LEFT — form */}
        <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>

          {/* 1. Patient */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="section-label" style={{ marginBottom: '4px' }}>Patient</label>
            {patientsError ? (
              <div style={{ color: 'var(--color-error)', fontSize: '0.82rem' }}>{patientsError}</div>
            ) : patientsLoading ? (
              <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.82rem' }}>Loading patients…</div>
            ) : (
              <>
                <select
                  className="select"
                  value={selectedPatientId}
                  onChange={(e) => setSelectedPatientId(e.target.value)}
                  required
                >
                  <option value="">Select a patient…</option>
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.firstName} {p.lastName} — DOB {p.dob} — MRN {p.mrn}
                    </option>
                  ))}
                </select>
                {selectedPatient && <PatientCard patient={selectedPatient} />}
              </>
            )}
          </div>

          {/* 2. Org */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="section-label" style={{ marginBottom: '4px' }}>Organization</label>
            {selectedOrg ? (
              <>
                <OrgCapabilityCard org={selectedOrg} plan={channelPlan} override={channelOverride} />
                <button
                  type="button"
                  onClick={() => { setSelectedOrg(null); setOrgQuery(''); }}
                  style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: '0.80rem', padding: '0', marginTop: '4px' }}
                >
                  Change organization
                </button>
              </>
            ) : (
              <div>
                <input
                  className="input"
                  type="text"
                  value={orgQuery}
                  onChange={(e) => setOrgQuery(e.target.value)}
                  placeholder="Search by org name…"
                />
                {orgsLoading && (
                  <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.78rem', marginTop: '4px' }}>Searching…</div>
                )}
                {!orgsLoading && orgs.length > 0 && (
                  <div
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius)',
                      marginTop: '6px',
                      maxHeight: '220px',
                      overflowY: 'auto',
                      background: 'var(--color-surface)',
                      boxShadow: 'var(--shadow-md)',
                    }}
                  >
                    {orgs.map((org) => {
                      const isPortal = org.contact?.preferred_channel === 'portal';
                      return (
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
                            borderBottom: '1px solid #f2f4f7',
                            cursor: 'pointer',
                            fontSize: '0.84rem',
                            transition: 'background var(--transition)',
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#f5f6fc'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                        >
                          <span style={{ fontWeight: 600 }}>{org.name}</span>
                          {isPortal && (
                            <span className="badge badge-portal" style={{ marginLeft: '8px', fontSize: '0.68rem' }}>
                              🌐 Portal
                            </span>
                          )}
                          {!isPortal && org.contact?.preferred_channel && (
                            <span style={{ color: 'var(--color-ink-faint)', marginLeft: '8px', fontSize: '0.76rem' }}>
                              preferred: {org.contact.preferred_channel}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {!orgsLoading && orgQuery && orgs.length === 0 && (
                  <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.82rem', marginTop: '4px' }}>
                    No organizations match &quot;{orgQuery}&quot;.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 3. Records requested */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="section-label" style={{ marginBottom: '4px' }}>Records Requested</label>
            <textarea
              className="textarea"
              value={recordsRequested}
              onChange={(e) => setRecordsRequested(e.target.value)}
              placeholder="Describe the records needed (e.g. cardiology notes Jan 2024, radiology report, medication list…)"
              required
              rows={4}
            />
          </div>

          {/* 4. Channel override */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="section-label" style={{ marginBottom: '4px' }}>Channel Override</label>
            <select
              className="select"
              value={channelOverride}
              onChange={(e) => setChannelOverride(e.target.value as ChannelOverride)}
            >
              <option value="auto">Auto — use org preferred</option>
              <option value="fax">📠 Fax</option>
              <option value="email">✉️ Email</option>
              <option value="sms">💬 SMS</option>
              <option value="voice">📞 Voice</option>
              <option value="portal">🌐 Portal</option>
            </select>
            <div style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)' }}>
              Leave as Auto to follow the org&apos;s preferred channel escalation plan.
            </div>
          </div>

          {/* 5. Wait dial */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label className="section-label" style={{ marginBottom: '4px' }}>Response Wait Time</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              {WAIT_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setWaitSeconds(s)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    border: `2px solid ${waitSeconds === s ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    background: waitSeconds === s ? 'var(--color-accent-light)' : 'var(--color-surface)',
                    color: waitSeconds === s ? 'var(--color-accent)' : 'var(--color-ink-muted)',
                    fontWeight: 700,
                    fontSize: '0.84rem',
                    cursor: 'pointer',
                    transition: 'all var(--transition)',
                  }}
                >
                  {s}s
                </button>
              ))}
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)' }}>
              How long to wait for a response on each channel before escalating.
              {selectedOrg?.contact?.preferred_channel === 'portal' && (
                <span style={{ color: 'var(--color-portal)', marginLeft: '4px' }}>
                  Portal orgs have no timeout chase.
                </span>
              )}
            </div>
          </div>

          {/* Channel plan stepper (inside the form) */}
          {channelPlan.length > 0 && (
            <div className="card" style={{ padding: '14px 16px' }}>
              <ChannelPlanStepper plan={channelPlan} waitSeconds={waitSeconds} />
            </div>
          )}

          {/* Error */}
          {submitError && (
            <div
              style={{
                background: 'var(--color-error-bg)',
                border: '1px solid #fca5a5',
                borderRadius: 'var(--radius)',
                padding: '10px 16px',
                color: 'var(--color-error)',
                fontSize: '0.84rem',
              }}
            >
              {submitError}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start', padding: '11px 24px', fontSize: '0.95rem' }}
          >
            {submitting ? 'Sending request…' : 'Send ROI Request'}
          </button>
        </form>

        {/* RIGHT — document preview */}
        <div style={{ position: 'sticky', top: '76px' }}>
          <DocumentPreview
            channel={previewChannel}
            patient={selectedPatient}
            org={selectedOrg}
            recordsRequested={recordsRequested}
            waitSeconds={waitSeconds}
          />
        </div>
      </div>
    </div>
  );
}

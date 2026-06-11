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
  chase_policy?: { steps: string[]; waitSeconds: number };
}

interface OrgResult {
  id: string;
  name: string;
  contact?: OrgContact;
  tenantSlug?: string;
  capabilities?: { channels?: string[] };
}

type OutboundChannel = 'fax' | 'email' | 'sms' | 'voice' | 'care_everywhere';
type ChannelOverride = 'auto' | 'fax' | 'email' | 'sms' | 'voice';

const WAIT_OPTIONS = [10, 20, 30, 60] as const;
type WaitSeconds = (typeof WAIT_OPTIONS)[number];

// A chase step with repeat labeling
interface ChaseStep {
  channel: OutboundChannel;
  attempt: number; // 1-based per channel
}

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

const CHANNEL_ICONS: Record<string, string> = {
  fax:            '📠',
  email:          '✉️',
  sms:            '💬',
  voice:          '📞',
  care_everywhere:'⚡',
};

const CHANNEL_LABELS: Record<string, string> = {
  fax:            'Fax',
  email:          'Secure Email',
  sms:            'SMS',
  voice:          'Voice',
  care_everywhere:'Care Everywhere',
};

function isEpicOrg(org: OrgResult | null): boolean {
  return !!(org?.capabilities?.channels?.includes('cloud'));
}

/** Expand flat channel strings to ChaseStep[] with attempt counters per channel. */
function expandSteps(rawSteps: string[]): ChaseStep[] {
  const counts: Record<string, number> = {};
  return rawSteps.map((ch) => {
    counts[ch] = (counts[ch] ?? 0) + 1;
    return { channel: ch as OutboundChannel, attempt: counts[ch] };
  });
}

/** Contact info check: does the org have what we need for this channel? */
function hasContactFor(ch: string, contact: OrgContact): boolean {
  if (ch === 'fax')   return !!contact.fax;
  if (ch === 'email') return !!contact.email;
  if (ch === 'sms')   return !!contact.phone;
  if (ch === 'voice') return !!contact.phone;
  return true;
}

/**
 * Mirrors buildChannelPlan from lib/outbound.ts per the W1b spec.
 * Returns ChaseStep[] (steps, possibly with repeats).
 * agentChasePolicySteps = Records Chaser's config.chase_policy.steps fetched from /api/agents.
 */
function buildClientChasePlan(
  org: OrgResult | null,
  override: ChannelOverride,
  agentChasePolicySteps: string[] | null,
): ChaseStep[] {
  if (!org) return [];

  // 1. Care Everywhere → single step
  if (isEpicOrg(org)) {
    return [{ channel: 'care_everywhere', attempt: 1 }];
  }

  const contact = org.contact ?? {};

  // Determine base step list from policy hierarchy
  let rawSteps: string[];

  if (contact.chase_policy?.steps?.length) {
    rawSteps = contact.chase_policy.steps;
  } else if (agentChasePolicySteps && agentChasePolicySteps.length > 0) {
    rawSteps = agentChasePolicySteps;
  } else {
    rawSteps = ['fax', 'fax', 'voice'];
  }

  // Channel override forces first step
  if (override !== 'auto') {
    rawSteps = [override, ...rawSteps.filter((s) => s !== override)];
  }

  // Skip steps lacking contact info
  rawSteps = rawSteps.filter((ch) => hasContactFor(ch, contact));

  return expandSteps(rawSteps);
}

// ---------------------------------------------------------------------------
// Client-side document preview
// ---------------------------------------------------------------------------

function buildDocumentPreview(
  step: ChaseStep | null,
  patient: Patient | null,
  org: OrgResult | null,
  recordsRequested: string,
  waitSeconds: number,
): string {
  if (!patient || !org || !step) return '';

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const itemRef = 'ROI-????????';

  const { channel, attempt } = step;

  if (channel === 'care_everywhere') {
    return [
      '══════════════════════════════════════════════════════',
      '       CARE EVERYWHERE — RECORD QUERY              ',
      '══════════════════════════════════════════════════════',
      '',
      `From:       Epic Health System (Care Everywhere Network)`,
      `To:         ${org.name}`,
      `Date:       ${today}`,
      `Ref:        ${itemRef}`,
      `Channel:    C-CDA Structured Exchange`,
      '',
      '── Patient Demographics ──────────────────────────────',
      `  Name:     ${patient.firstName} ${patient.lastName}`,
      `  DOB:      ${patient.dob}`,
      `  MRN:      ${patient.mrn}`,
      '',
      '── Requested Records ─────────────────────────────────',
      `  ${recordsRequested || '(specify records above)'}`,
      '',
      '── Authorization ─────────────────────────────────────',
      '  Patient authorization on file per HIPAA §164.524.',
      '',
      '══════════════════════════════════════════════════════',
      '  Structured exchange — auto-response expected ~8s.   ',
      '══════════════════════════════════════════════════════',
    ].join('\n');
  }

  if (channel === 'fax') {
    const isSecondRequest = attempt >= 2;
    return [
      '═══════════════════════════════════════════════',
      isSecondRequest
        ? '    *** SECOND REQUEST — FACSIMILE COVER SHEET ***   '
        : '         *** FACSIMILE COVER SHEET ***          ',
      '═══════════════════════════════════════════════',
      '',
      `TO:      ${org.name}`,
      `FAX:     ${org.contact?.fax ?? '(on file)'}`,
      `FROM:    Epic Health System — ROI Coordinator`,
      `DATE:    ${today}`,
      `RE:      Records Request — ${patient.firstName} ${patient.lastName}`,
      `PAGES:   1 (cover sheet only)`,
      `REF:     ${itemRef}`,
      ...(isSecondRequest ? ['', 'NOTE:    This is our SECOND REQUEST. No response received.'] : []),
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
      `Subject: [Secure] Records Request — ${patient.firstName} ${patient.lastName} (ref ${itemRef})`,
      '',
      `Dear ${org.name} Health Information Team,`,
      '',
      `We are writing via secure email to request medical records for the following patient:`,
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
      'This message was transmitted via secure encrypted channel.',
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
  steps,
}: {
  org: OrgResult;
  steps: ChaseStep[];
}) {
  const contact = org.contact ?? {};
  const isCE = isEpicOrg(org);

  const channelPresence: { ch: string; label: string }[] = [];
  if (contact.fax)   channelPresence.push({ ch: 'fax',   label: contact.fax });
  if (contact.email) channelPresence.push({ ch: 'email', label: contact.email });
  if (contact.phone) channelPresence.push({ ch: 'voice', label: contact.phone });

  return (
    <div
      style={{
        padding: '14px 16px',
        background: isCE ? '#eef2ff' : '#f0fdf4',
        border: `1.5px solid ${isCE ? 'var(--color-accent-subtle)' : '#6ee7b7'}`,
        borderRadius: 'var(--radius)',
        marginTop: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{org.name}</div>
        {isCE && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 10px',
              borderRadius: '99px',
              fontSize: '0.72rem',
              fontWeight: 700,
              background: '#4f46e5',
              color: '#fff',
              letterSpacing: '0.02em',
            }}
          >
            ⚡ Epic · Care Everywhere
          </span>
        )}
      </div>

      {isCE && (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-accent)', marginTop: '2px' }}>
          Structured exchange — instant, no fax
        </div>
      )}

      {!isCE && channelPresence.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
          {channelPresence.map(({ ch }) => {
            const inPlan = steps.some((s) => s.channel === ch);
            return (
              <span
                key={ch}
                className={`chip${inPlan ? ' preferred' : ''}`}
              >
                {CHANNEL_ICONS[ch]} {CHANNEL_LABELS[ch]}
                {!inPlan && (
                  <span style={{ opacity: 0.5, marginLeft: '2px', fontSize: '0.65rem' }}>skipped</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Render a step label like "📠 Fax (1st)" or "📠 Fax (2nd)" or just "📠 Fax" when no repeats */
function stepLabel(step: ChaseStep, hasRepeats: boolean): string {
  const icon = CHANNEL_ICONS[step.channel] ?? '';
  const label = CHANNEL_LABELS[step.channel] ?? step.channel;
  if (!hasRepeats || step.channel === 'care_everywhere') return `${icon} ${label}`;
  const ordinals = ['1st', '2nd', '3rd', '4th'];
  const ord = ordinals[step.attempt - 1] ?? `${step.attempt}th`;
  return `${icon} ${label} (${ord})`;
}

function ChannelPlanStepper({
  steps,
  waitSeconds,
}: {
  steps: ChaseStep[];
  waitSeconds: number;
}) {
  if (steps.length === 0) return null;

  const channelRepeatCounts: Record<string, number> = {};
  for (const s of steps) {
    channelRepeatCounts[s.channel] = (channelRepeatCounts[s.channel] ?? 0) + 1;
  }
  const hasAnyRepeat = Object.values(channelRepeatCounts).some((c) => c > 1);

  const isCE = steps.length === 1 && steps[0].channel === 'care_everywhere';

  return (
    <div>
      <div className="section-label" style={{ marginBottom: '8px' }}>Channel Plan</div>
      <div className="stepper">
        {steps.map((s, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span className="stepper-step" style={{ fontSize: '0.80rem' }}>
              <span>{i + 1}</span>
              <span>{stepLabel(s, hasAnyRepeat)}</span>
            </span>
            {i < steps.length - 1 && (
              <span className="stepper-arrow">
                &nbsp;→ wait {waitSeconds}s →&nbsp;
              </span>
            )}
          </span>
        ))}
      </div>
      {isCE && (
        <div style={{ fontSize: '0.77rem', color: 'var(--color-accent)', marginTop: '6px' }}>
          Care Everywhere orgs receive a single structured query with no escalation chain.
        </div>
      )}
    </div>
  );
}

function DocumentPreview({
  step,
  patient,
  org,
  recordsRequested,
  waitSeconds,
}: {
  step: ChaseStep | null;
  patient: Patient | null;
  org: OrgResult | null;
  recordsRequested: string;
  waitSeconds: number;
}) {
  const text = buildDocumentPreview(step, patient, org, recordsRequested, waitSeconds);
  const channel = step?.channel ?? 'fax';

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

  // Records Chaser agent config (fetched once)
  const [agentChasePolicySteps, setAgentChasePolicySteps] = useState<string[] | null>(null);

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
  // Load Records Chaser config (for plan preview fallback)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as
          | { data: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>;
        const agents = Array.isArray(body) ? body : ((body as { data: Array<Record<string, unknown>> }).data ?? []);
        // Find the ROI outgoing / Records Chaser agent
        const chaser = agents.find((a) => {
          const qk = (a.queue_key ?? a.queueKey) as string | undefined;
          return qk === 'roi_outgoing';
        });
        if (chaser) {
          const cfg = (chaser.config as Record<string, unknown> | undefined) ?? {};
          const policy = cfg.chase_policy as { steps?: string[] } | undefined;
          if (policy?.steps?.length) {
            setAgentChasePolicySteps(policy.steps);
          }
        }
      } catch {
        // non-critical — fall back to default ladder
      }
    }
    void loadAgents();
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
  const chasePlan = buildClientChasePlan(selectedOrg, channelOverride, agentChasePolicySteps);
  const previewStep = chasePlan[0] ?? null;
  const isCE = isEpicOrg(selectedOrg);

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
                <OrgCapabilityCard org={selectedOrg} steps={chasePlan} />
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
                      const isEpic = isEpicOrg(org);
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
                          {isEpic && (
                            <span
                              style={{
                                marginLeft: '8px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                padding: '1px 7px',
                                borderRadius: '99px',
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                background: '#4f46e5',
                                color: '#fff',
                              }}
                            >
                              ⚡ CE
                            </span>
                          )}
                          {!isEpic && org.contact?.preferred_channel && (
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

          {/* 4. Channel override — hidden for CE orgs */}
          {!isCE && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label className="section-label" style={{ marginBottom: '4px' }}>Channel Override</label>
              <select
                className="select"
                value={channelOverride}
                onChange={(e) => setChannelOverride(e.target.value as ChannelOverride)}
              >
                <option value="auto">Auto — follow org chase policy</option>
                <option value="fax">📠 Fax</option>
                <option value="email">✉️ Secure Email</option>
                <option value="sms">💬 SMS</option>
                <option value="voice">📞 Voice</option>
              </select>
              <div style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)' }}>
                Leave as Auto to follow the org&apos;s configured escalation ladder.
              </div>
            </div>
          )}

          {/* 5. Wait dial — hidden for CE orgs */}
          {!isCE && (
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
              </div>
            </div>
          )}

          {/* Channel plan stepper */}
          {chasePlan.length > 0 && (
            <div className="card" style={{ padding: '14px 16px' }}>
              <ChannelPlanStepper steps={chasePlan} waitSeconds={waitSeconds} />
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
            step={previewStep}
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

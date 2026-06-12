'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePersona } from '@/app/components/PersonaProvider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PortalRequest {
  id: string;
  status: string;
  queue_key: string;
  source_channel: string;
  review_reason?: string | null;
  created_at: string;
  updated_at?: string;
  patient?: {
    first_name?: string;
    lastName?: string;
    firstName?: string;
    last_name?: string;
    dob?: string;
  } | null;
  org?: { name?: string } | null;
  // Attempt state for request_more_info
  pending_auth_attempt?: {
    id: string;
    status: string;
  } | null;
  // Final response doc when done
  response_document?: string | null;
  response_channel?: string | null;
}

interface PortalRequestsResponse {
  data: PortalRequest[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return ts;
  }
}

function patientName(req: PortalRequest): string {
  const p = req.patient;
  if (!p) return '—';
  const first = p.firstName ?? p.first_name ?? '';
  const last = p.lastName ?? p.last_name ?? '';
  return [first, last].filter(Boolean).join(' ') || '—';
}

// Map internal item state to plain-language status chip
type StatusInfo = {
  label: string;
  bg: string;
  fg: string;
  actionNeeded: boolean;
  completedChannel?: string;
};

function resolveStatus(req: PortalRequest): StatusInfo {
  const { status, queue_key } = req;

  if (status === 'completed' || status === 'done') {
    const ch = req.response_channel ?? '';
    const chLabel =
      ch === 'care_everywhere' ? 'Care Everywhere' :
      ch === 'fax'   ? 'fax' :
      ch === 'email' ? 'email' :
      ch === 'voice' ? 'phone call' :
      ch === 'portal' ? 'portal' :
      ch || 'secure channel';
    return {
      label: `Completed — records sent via ${chLabel}`,
      bg: '#d1fae5',
      fg: '#065f46',
      actionNeeded: false,
      completedChannel: ch,
    };
  }

  if (status === 'under_review' || queue_key === 'human_review' || status === 'human_review') {
    return {
      label: 'Under review',
      bg: '#fef3c7',
      fg: '#92400e',
      actionNeeded: false,
    };
  }

  // Waiting on authorization (request_more_info was issued)
  if (req.pending_auth_attempt) {
    return {
      label: 'Action needed — authorization required',
      bg: '#fee2e2',
      fg: '#dc2626',
      actionNeeded: true,
    };
  }

  // Default processing states
  return {
    label: 'Received — processing',
    bg: '#dbeafe',
    fg: '#1d4ed8',
    actionNeeded: false,
  };
}

// ---------------------------------------------------------------------------
// New request form
// ---------------------------------------------------------------------------

interface NewRequestFormProps {
  orgId: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

function NewRequestForm({ orgId, onSubmitted, onCancel }: NewRequestFormProps) {
  const [patientFirstName, setPatientFirstName] = useState('');
  const [patientLastName, setPatientLastName] = useState('');
  const [patientDob, setPatientDob] = useState('');
  const [recordsRequested, setRecordsRequested] = useState('');
  const [authorizationAttached, setAuthorizationAttached] = useState(false);
  const [priority, setPriority] = useState('routine');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientFirstName.trim() || !patientLastName.trim() || !patientDob.trim() || !recordsRequested.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          patientFirstName: patientFirstName.trim(),
          patientLastName: patientLastName.trim(),
          patientDob: patientDob.trim(),
          recordsRequested: recordsRequested.trim(),
          authorizationAttached,
          priority,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string | { message?: string } };
        const msg = typeof body.error === 'object' && body.error !== null
          ? (body.error as { message?: string }).message ?? 'Failed to submit'
          : (body.error as string) ?? 'Failed to submit';
        setError(msg);
        return;
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        padding: '24px 28px',
        marginBottom: '28px',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0, color: 'var(--color-ink)' }}>
          New records request
        </h2>
        <button
          onClick={onCancel}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-ink-faint)', fontSize: '1.1rem', lineHeight: 1 }}
        >
          &times;
        </button>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Patient name */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Patient first name *</label>
            <input
              className="input"
              value={patientFirstName}
              onChange={(e) => setPatientFirstName(e.target.value)}
              placeholder="Jane"
              required
            />
          </div>
          <div>
            <label style={labelStyle}>Patient last name *</label>
            <input
              className="input"
              value={patientLastName}
              onChange={(e) => setPatientLastName(e.target.value)}
              placeholder="Smith"
              required
            />
          </div>
        </div>

        {/* DOB */}
        <div>
          <label style={labelStyle}>Date of birth *</label>
          <input
            className="input"
            type="text"
            value={patientDob}
            onChange={(e) => setPatientDob(e.target.value)}
            placeholder="MM/DD/YYYY"
            required
          />
        </div>

        {/* Records requested */}
        <div>
          <label style={labelStyle}>Records requested *</label>
          <textarea
            className="textarea"
            value={recordsRequested}
            onChange={(e) => setRecordsRequested(e.target.value)}
            placeholder="Describe the records needed (e.g. discharge summary from March 2024, medication list, lab results…)"
            rows={4}
            required
          />
        </div>

        {/* Priority */}
        <div>
          <label style={labelStyle}>Priority</label>
          <select
            className="select"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="stat">STAT</option>
          </select>
        </div>

        {/* Authorization */}
        <label
          style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', fontSize: '0.88rem' }}
        >
          <input
            type="checkbox"
            checked={authorizationAttached}
            onChange={(e) => setAuthorizationAttached(e.target.checked)}
            style={{ marginTop: '2px', width: '15px', height: '15px', accentColor: 'var(--color-portal)', cursor: 'pointer' }}
          />
          <span>
            <strong>Signed authorization attached</strong>
            <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--color-ink-muted)', marginTop: '1px' }}>
              Check this if you have a signed patient authorization form ready to attach. You can also attach it later if requested.
            </span>
          </span>
        </label>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--color-error-bg)',
              border: '1px solid #fca5a5',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-error)',
              fontSize: '0.84rem',
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '10px 22px',
              background: submitting ? 'var(--color-border)' : 'var(--color-portal)',
              color: submitting ? 'var(--color-ink-faint)' : '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 700,
              fontSize: '0.88rem',
              cursor: submitting ? 'default' : 'pointer',
              transition: 'background var(--transition)',
            }}
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request card
// ---------------------------------------------------------------------------

function RequestCard({
  req,
  orgId,
  onRefresh,
}: {
  req: PortalRequest;
  orgId: string;
  onRefresh: () => void;
}) {
  const statusInfo = resolveStatus(req);
  const [attachingAuth, setAttachingAuth] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState(false);
  const [docExpanded, setDocExpanded] = useState(false);

  async function handleAttachAuth() {
    if (!req.pending_auth_attempt) return;
    setAttachingAuth(true);
    setAuthError(null);
    try {
      const res = await fetch('/api/portal/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: req.pending_auth_attempt.id,
          orgId,
          authorizationAttached: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string | { message?: string } };
        const msg = typeof body.error === 'object' && body.error !== null
          ? (body.error as { message?: string }).message ?? 'Failed'
          : (body.error as string) ?? 'Failed';
        setAuthError(msg);
      } else {
        setAuthSuccess(true);
        setTimeout(() => {
          setAuthSuccess(false);
          onRefresh();
        }, 1500);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setAttachingAuth(false);
    }
  }

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderLeft: `4px solid ${statusInfo.actionNeeded ? 'var(--color-error)' : statusInfo.fg}`,
        borderRadius: 'var(--radius)',
        padding: '18px 20px',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-ink)', marginBottom: '2px' }}>
            {patientName(req)}
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)' }}>
            Submitted {fmtDate(req.created_at)}
          </div>
        </div>

        {/* Status chip */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '4px 12px',
            borderRadius: '99px',
            fontSize: '0.76rem',
            fontWeight: 700,
            background: statusInfo.bg,
            color: statusInfo.fg,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {statusInfo.actionNeeded && <span>&#9888;</span>}
          {statusInfo.label}
        </span>
      </div>

      {/* Action needed: authorization attach button */}
      {statusInfo.actionNeeded && (
        <div
          style={{
            padding: '12px 14px',
            background: '#fff5f5',
            border: '1px solid #fca5a5',
            borderRadius: 'var(--radius-sm)',
            marginBottom: '10px',
          }}
        >
          <div style={{ fontSize: '0.84rem', color: '#7f1d1d', marginBottom: '8px', lineHeight: 1.4 }}>
            The receiving organization requires a signed patient authorization before releasing records.
          </div>
          {authSuccess ? (
            <div style={{ fontSize: '0.84rem', color: 'var(--color-success)', fontWeight: 700 }}>
              Authorization attached — thank you. Your request will continue processing.
            </div>
          ) : (
            <button
              onClick={() => void handleAttachAuth()}
              disabled={attachingAuth}
              style={{
                padding: '7px 16px',
                background: attachingAuth ? 'var(--color-border)' : 'var(--color-error)',
                color: attachingAuth ? 'var(--color-ink-faint)' : '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: attachingAuth ? 'default' : 'pointer',
              }}
            >
              {attachingAuth ? 'Attaching…' : 'Attach signed authorization'}
            </button>
          )}
          {authError && (
            <div style={{ fontSize: '0.78rem', color: 'var(--color-error)', marginTop: '6px' }}>{authError}</div>
          )}
        </div>
      )}

      {/* Completed: view response document */}
      {(req.status === 'completed' || req.status === 'done') && req.response_document && (
        <div style={{ marginTop: '6px' }}>
          <button
            onClick={() => setDocExpanded((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-portal)',
              cursor: 'pointer',
              fontSize: '0.80rem',
              fontWeight: 600,
              padding: 0,
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {docExpanded ? '▾' : '▸'} View response document
          </button>
          {docExpanded && (
            <div
              className="card-paper"
              style={{ marginTop: '8px', maxHeight: '320px', overflowY: 'auto', fontSize: '0.76rem' }}
            >
              {req.response_document}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portal page
// ---------------------------------------------------------------------------

interface Props {
  params: { orgId: string };
}

export default function PortalOrgPage({ params }: Props) {
  const { orgId } = params;
  const { persona, setPersona, hydrated } = usePersona();

  const [orgName, setOrgName] = useState<string>('');
  const [requests, setRequests] = useState<PortalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch org name
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function fetchOrgName() {
      try {
        const res = await fetch('/api/organizations?q=', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
        const org = body.data?.find((o) => o.id === orgId);
        if (org) setOrgName(org.name);
      } catch {
        // non-critical
      }
    }
    void fetchOrgName();
  }, [orgId]);

  // ---------------------------------------------------------------------------
  // Fetch My Requests (4s polling)
  // ---------------------------------------------------------------------------

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/requests?orgId=${encodeURIComponent(orgId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        // Endpoint may not exist yet (engine building in parallel) — fail gracefully
        if (res.status === 404) {
          setRequests([]);
          setError(null);
          setLoading(false);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as PortalRequestsResponse | PortalRequest[];
      const data = Array.isArray(body) ? body : ((body as PortalRequestsResponse).data ?? []);
      // Normalize camelCase fields that may come from API
      for (const r of data) {
        const o = r as unknown as Record<string, unknown>;
        if ('queueKey' in o && !('queue_key' in o)) o.queue_key = o.queueKey;
        if ('createdAt' in o && !('created_at' in o)) o.created_at = o.createdAt;
        if ('reviewReason' in o && !('review_reason' in o)) o.review_reason = o.reviewReason;
        if ('responseDocument' in o && !('response_document' in o)) o.response_document = o.responseDocument;
        if ('responseChannel' in o && !('response_channel' in o)) o.response_channel = o.responseChannel;
        if ('pendingAuthAttempt' in o && !('pending_auth_attempt' in o)) o.pending_auth_attempt = o.pendingAuthAttempt;
        const p = o.patient as Record<string, unknown> | null | undefined;
        if (p) {
          if ('firstName' in p && !('first_name' in p)) p.first_name = p.firstName;
          if ('lastName' in p && !('last_name' in p)) p.last_name = p.lastName;
        }
      }
      setRequests(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void fetchRequests();
    const interval = setInterval(() => void fetchRequests(), 4_000);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  // ---------------------------------------------------------------------------
  // Persona
  // ---------------------------------------------------------------------------

  const showOfferBanner = hydrated && (
    persona.mode === 'console' ||
    (persona.mode === 'provider' && persona.orgId !== orgId)
  );

  const resolvedOrgName = orgName || orgId;

  function handleSwitchPersona() {
    setPersona({ mode: 'provider', orgId, orgName: resolvedOrgName });
  }

  function handleSubmitSuccess() {
    setShowNewForm(false);
    setSubmitSuccess(true);
    setTimeout(() => setSubmitSuccess(false), 4000);
    void fetchRequests();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: '20px' }}>
        <a
          href="/portal"
          style={{ fontSize: '0.82rem', color: 'var(--color-portal)', textDecoration: 'none', fontWeight: 600 }}
        >
          &#8592; Provider Portal
        </a>
      </div>

      {/* Persona offer-to-switch banner */}
      {showOfferBanner && (
        <div className="portal-offer-banner" style={{ marginBottom: '20px' }}>
          <span style={{ flex: 1, fontSize: '0.84rem' }}>
            {persona.mode === 'console'
              ? `You are in Network Console mode. Act as `
              : `You are acting as ${persona.orgName}. Switch to `}
            <strong>{resolvedOrgName}</strong> to submit and track records requests.
          </span>
          <button className="portal-offer-banner-btn" onClick={handleSwitchPersona}>
            View as {resolvedOrgName}
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <div
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            background: 'var(--color-portal-bg)',
            borderRadius: '20px',
            fontSize: '0.72rem',
            fontWeight: 700,
            color: 'var(--color-portal)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginBottom: '10px',
          }}
        >
          {hydrated && persona.mode === 'provider' && persona.orgId === orgId
            ? `Acting as ${resolvedOrgName}`
            : 'Provider Portal'}
        </div>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--color-ink)', margin: '0 0 6px' }}>
          {resolvedOrgName}
        </h1>
        <p style={{ color: 'var(--color-ink-muted)', margin: 0, fontSize: '0.88rem' }}>
          Submit and track records requests to Epic Health System.
        </p>
      </div>

      {/* New request CTA */}
      {!showNewForm && (
        <button
          onClick={() => setShowNewForm(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 22px',
            background: 'var(--color-portal)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontWeight: 700,
            fontSize: '0.92rem',
            cursor: 'pointer',
            marginBottom: '28px',
            transition: 'background var(--transition)',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#0f766e'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-portal)'; }}
        >
          + New records request
        </button>
      )}

      {/* New request form */}
      {showNewForm && (
        <NewRequestForm
          orgId={orgId}
          onSubmitted={handleSubmitSuccess}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      {/* Submit success toast */}
      {submitSuccess && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--color-success-bg)',
            border: '1px solid #6ee7b7',
            borderRadius: 'var(--radius)',
            color: 'var(--color-success)',
            fontSize: '0.84rem',
            fontWeight: 600,
            marginBottom: '20px',
          }}
        >
          Request submitted successfully. It will appear below as it moves through processing.
        </div>
      )}

      {/* My Requests section */}
      <div>
        <div className="section-label" style={{ marginBottom: '14px' }}>
          My requests
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: '6px' }}>
            &#8212; polls every 4s
          </span>
        </div>

        {loading && (
          <div style={{ color: 'var(--color-ink-faint)', padding: '32px 0', fontSize: '0.88rem' }}>
            Loading requests&#8230;
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '14px',
              background: 'var(--color-error-bg)',
              border: '1px solid #fecaca',
              borderRadius: 'var(--radius)',
              color: 'var(--color-error)',
              fontSize: '0.84rem',
              marginBottom: '14px',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && requests.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '56px 24px',
              color: 'var(--color-ink-faint)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>&#128203;</div>
            <div style={{ fontWeight: 700, color: 'var(--color-ink-muted)', marginBottom: '4px' }}>
              No requests yet
            </div>
            <div style={{ fontSize: '0.84rem' }}>
              Submit a new records request using the button above.
            </div>
          </div>
        )}

        {requests.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {requests.map((req) => (
              <RequestCard
                key={req.id}
                req={req}
                orgId={orgId}
                onRefresh={() => void fetchRequests()}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.78rem',
  fontWeight: 700,
  color: 'var(--color-ink-muted)',
  marginBottom: '5px',
};

'use client';

import { useEffect, useState } from 'react';
import type { PortalAttempt } from '@/lib/portal';

// ---------------------------------------------------------------------------
// Channel badge helpers
// ---------------------------------------------------------------------------

function channelLabel(channel: string): string {
  switch (channel) {
    case 'portal': return 'In-app';
    case 'fax': return 'via fax';
    case 'email': return 'via email';
    case 'sms': return 'via SMS';
    case 'voice': return 'via phone';
    default: return channel;
  }
}

function channelIcon(channel: string): string {
  switch (channel) {
    case 'portal': return 'In-app';
    case 'fax': return 'Fax';
    case 'email': return 'Email';
    case 'sms': return 'SMS';
    case 'voice': return 'Voice';
    default: return channel;
  }
}

const CHANNEL_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  portal: { bg: '#ccfbf1', fg: '#0d9488' },
  fax: { bg: '#f3f4f6', fg: '#374151' },
  email: { bg: '#dbeafe', fg: '#1d4ed8' },
  sms: { bg: '#d1fae5', fg: '#065f46' },
  voice: { bg: '#ede9fe', fg: '#5b21b6' },
};

function ChannelBadge({ channel }: { channel: string }) {
  const colors = CHANNEL_BADGE_COLORS[channel] ?? { bg: '#f3f4f6', fg: '#374151' };
  const icon = channel === 'portal' ? '🌐' : channel === 'fax' ? '📠' : channel === 'email' ? '✉️' : channel === 'sms' ? '💬' : '📞';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '0.72rem',
        fontWeight: 700,
        background: colors.bg,
        color: colors.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {icon} {channelIcon(channel)} {channel !== 'portal' && <span style={{ fontWeight: 400 }}>{channelLabel(channel)}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  sent: { bg: '#dbeafe', fg: '#1d4ed8' },
  awaiting_response: { bg: '#fef3c7', fg: '#92400e' },
  responded: { bg: '#d1fae5', fg: '#065f46' },
  timed_out: { bg: '#fee2e2', fg: '#dc2626' },
  failed: { bg: '#fef2f2', fg: '#b91c1c' },
};

function StatusPill({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#f3f4f6', fg: '#6b7280' };
  const label = status.replace(/_/g, ' ');
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '20px',
        fontSize: '0.72rem',
        fontWeight: 700,
        background: colors.bg,
        color: colors.fg,
        textTransform: 'capitalize',
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attempt card
// ---------------------------------------------------------------------------

interface AttemptCardProps {
  attempt: PortalAttempt;
  orgId: string;
  onResponded: () => void;
}

function AttemptCard({ attempt, orgId, onResponded }: AttemptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState(false);
  const [message, setMessage] = useState('');
  const [recordsAttached, setRecordsAttached] = useState(false);
  const [authorizationAttached, setAuthorizationAttached] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isResponded = attempt.status === 'responded';
  const canRespond = attempt.status === 'sent' || attempt.status === 'awaiting_response';

  const subject = typeof attempt.payload['subject'] === 'string'
    ? attempt.payload['subject']
    : `Records Request — Attempt ${attempt.attempt_no}`;

  const document = typeof attempt.payload['document'] === 'string'
    ? attempt.payload['document']
    : null;

  // Infer kind from payload subject or kind field
  const payloadKind = attempt.payload['kind'] as string | undefined;
  const isMoreInfo = payloadKind === 'request_more_info' ||
    subject.toLowerCase().includes('additional information');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/portal/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: attempt.id,
          orgId,
          message: message.trim(),
          recordsAttached,
          authorizationAttached,
        }),
      });
      const body = (await res.json()) as { error?: { message: string } };
      if (!res.ok) {
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setResponding(false);
      onResponded();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit response');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${isResponded ? '#bbf7d0' : '#e6e8ee'}`,
        borderLeft: `4px solid ${isResponded ? '#16a34a' : canRespond ? '#4f46e5' : '#d1d5db'}`,
        borderRadius: '10px',
        padding: '18px 20px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <ChannelBadge channel={attempt.channel} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#16181d', fontSize: '0.95rem' }}>{subject}</div>
          {attempt.patient_name && (
            <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: '1px' }}>
              Patient: <strong>{attempt.patient_name}</strong>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>Attempt #{attempt.attempt_no}</span>
          <StatusPill status={attempt.status} />
        </div>
      </div>

      {/* View document expander */}
      {document && (
        <div style={{ marginBottom: '12px' }}>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: '#4f46e5',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            }}
          >
            {expanded ? 'Hide document ▲' : 'View document ▼'}
          </button>
          {expanded && (
            <pre
              style={{
                marginTop: '10px',
                padding: '14px',
                background: '#f8fafc',
                border: '1px solid #e6e8ee',
                borderRadius: '6px',
                fontFamily: '"Courier New", Courier, monospace',
                fontSize: '0.78rem',
                color: '#16181d',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowX: 'auto',
              }}
            >
              {document}
            </pre>
          )}
        </div>
      )}

      {/* Responded — read-only view */}
      {isResponded && attempt.response && (() => {
        const resp = attempt.response;
        const receivedAt = typeof resp['received_at'] === 'string' ? resp['received_at'] : null;
        const respMessage = typeof resp['message'] === 'string' ? resp['message'] : null;
        const authorization = typeof resp['authorization'] === 'string' ? resp['authorization'] : null;
        const respDocument = typeof resp['document'] === 'string' ? resp['document'] : null;
        return (
          <div
            style={{
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#16a34a', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '4px' }}>
              Response submitted
              {receivedAt && (
                <span style={{ fontWeight: 400, marginLeft: '6px' }}>
                  — {new Date(receivedAt).toLocaleString()}
                </span>
              )}
            </div>
            {respMessage && (
              <div style={{ fontSize: '0.85rem', color: '#16181d', marginBottom: '6px' }}>
                {respMessage}
              </div>
            )}
            {authorization && (
              <div style={{ fontSize: '0.78rem', color: '#0d9488', fontWeight: 600 }}>
                Authorization: {authorization}
              </div>
            )}
            {respDocument && (
              <pre
                style={{
                  marginTop: '8px',
                  padding: '10px',
                  background: '#fff',
                  border: '1px solid #d1fae5',
                  borderRadius: '6px',
                  fontFamily: '"Courier New", Courier, monospace',
                  fontSize: '0.75rem',
                  color: '#065f46',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {respDocument}
              </pre>
            )}
          </div>
        );
      })()}

      {/* Respond panel */}
      {canRespond && (
        <div style={{ marginTop: '10px' }}>
          {!responding ? (
            <button
              onClick={() => setResponding(true)}
              style={{
                padding: '8px 16px',
                background: '#4f46e5',
                color: '#fff',
                border: 'none',
                borderRadius: '7px',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Respond
            </button>
          ) : (
            <form
              onSubmit={(e) => void handleSubmit(e)}
              style={{
                background: '#fafbfc',
                border: '1px solid #e6e8ee',
                borderRadius: '8px',
                padding: '14px',
              }}
            >
              <div style={{ marginBottom: '10px' }}>
                <label
                  htmlFor={`msg-${attempt.id}`}
                  style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, color: '#374151', marginBottom: '4px' }}
                >
                  Message
                </label>
                <textarea
                  id={`msg-${attempt.id}`}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Enter your response message…"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                {!isMoreInfo && (
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={recordsAttached}
                      onChange={(e) => setRecordsAttached(e.target.checked)}
                    />
                    Attach requested records
                  </label>
                )}
                {isMoreInfo && (
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={authorizationAttached}
                      onChange={(e) => setAuthorizationAttached(e.target.checked)}
                    />
                    Attach signed authorization
                  </label>
                )}
              </div>

              {submitError && (
                <div
                  style={{
                    padding: '8px 10px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '6px',
                    color: '#dc2626',
                    fontSize: '0.8rem',
                    marginBottom: '10px',
                  }}
                >
                  {submitError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="submit"
                  disabled={submitting || !message.trim()}
                  style={{
                    padding: '8px 16px',
                    background: submitting || !message.trim() ? '#a5b4fc' : '#4f46e5',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '7px',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: submitting || !message.trim() ? 'default' : 'pointer',
                  }}
                >
                  {submitting ? 'Submitting…' : 'Submit Response'}
                </button>
                <button
                  type="button"
                  onClick={() => { setResponding(false); setSubmitError(null); }}
                  style={{
                    padding: '8px 14px',
                    background: '#f3f4f6',
                    color: '#374151',
                    border: '1px solid #e5e7eb',
                    borderRadius: '7px',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox page
// ---------------------------------------------------------------------------

interface Props {
  params: { orgId: string };
}

export default function PortalInboxPage({ params }: Props) {
  const { orgId } = params;

  const [attempts, setAttempts] = useState<PortalAttempt[]>([]);
  const [orgName, setOrgName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchInbox() {
    try {
      const res = await fetch(`/api/portal/inbox?orgId=${encodeURIComponent(orgId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load inbox');
      const body = (await res.json()) as { data: PortalAttempt[] };
      setAttempts(body.data ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function fetchOrgName() {
    try {
      const res = await fetch(`/api/organizations?q=`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
      const org = body.data?.find((o) => o.id === orgId);
      if (org) {
        setOrgName(org.name);
        // Remember for "Continue as" on landing page
        try {
          localStorage.setItem('portal_last_org', JSON.stringify({ id: orgId, name: org.name }));
        } catch {
          // ignore
        }
      }
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    void fetchInbox();
    void fetchOrgName();

    // Poll every 4s
    const interval = setInterval(() => {
      void fetchInbox();
    }, 4_000);
    return () => clearInterval(interval);
  }, [orgId]);

  return (
    <div style={{ maxWidth: '780px', margin: '0 auto', padding: '40px 24px' }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: '24px' }}>
        <a
          href="/portal"
          style={{ fontSize: '0.82rem', color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}
        >
          ← Provider Portal
        </a>
      </div>

      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <div
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            background: '#ccfbf1',
            borderRadius: '20px',
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#0d9488',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginBottom: '10px',
          }}
        >
          On Network
        </div>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800, color: '#16181d', margin: '0 0 6px' }}>
          {orgName || orgId}
        </h1>
        <p style={{ color: '#6b7280', margin: 0, fontSize: '0.88rem' }}>
          Inbox — records requests sent to your organization. Updates every 4 seconds.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ color: '#9ca3af', padding: '32px 0' }}>Loading inbox…</div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            padding: '16px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            color: '#dc2626',
            fontSize: '0.85rem',
            marginBottom: '16px',
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && attempts.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 24px',
            color: '#9ca3af',
            background: '#fff',
            border: '1px solid #e6e8ee',
            borderRadius: '10px',
          }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '12px' }}>📥</div>
          <div style={{ fontWeight: 700, color: '#6b7280', marginBottom: '4px' }}>No requests yet</div>
          <div style={{ fontSize: '0.85rem' }}>
            Records requests addressed to your organization will appear here.
          </div>
        </div>
      )}

      {/* Attempt list */}
      {!loading && attempts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {attempts.map((attempt) => (
            <AttemptCard
              key={attempt.id}
              attempt={attempt}
              orgId={orgId}
              onResponded={() => void fetchInbox()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { WorkItem, AuditLogEntry, OutboundAttempt, Patient } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types matching the API contract from the spec
// ---------------------------------------------------------------------------

interface WorkItemDetail {
  item: WorkItem & { sourceText?: string; agentState?: Record<string, unknown> };
  audit: AuditLogEntry[];
  attempts: OutboundAttempt[];
  patientCandidates: Patient[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceColor(score: number): string {
  if (score >= 0.8) return '#059669';
  if (score >= 0.5) return '#d97706';
  return '#dc2626';
}

function confidenceBg(score: number): string {
  if (score >= 0.8) return '#d1fae5';
  if (score >= 0.5) return '#fef3c7';
  return '#fee2e2';
}

function actorBadge(actor: string): { label: string; bg: string; color: string } {
  if (actor.startsWith('agent:')) return { label: actor, bg: '#ede9fe', color: '#6d28d9' };
  if (actor === 'human') return { label: 'human', bg: '#dbeafe', color: '#1d4ed8' };
  return { label: actor, bg: '#f3f4f6', color: '#374151' };
}

function statusBadge(status: string): { bg: string; color: string } {
  switch (status) {
    case 'sent': return { bg: '#dbeafe', color: '#1d4ed8' };
    case 'awaiting_response': return { bg: '#fef3c7', color: '#92400e' };
    case 'responded': return { bg: '#d1fae5', color: '#065f46' };
    case 'timed_out': return { bg: '#fee2e2', color: '#991b1b' };
    case 'failed': return { bg: '#fee2e2', color: '#991b1b' };
    default: return { bg: '#f3f4f6', color: '#374151' };
  }
}

function channelIcon(channel: string): string {
  switch (channel) {
    case 'fax': return '⏡'; // fax symbol approximation
    case 'email': return '✉️';
    case 'sms': return '💬';
    case 'voice': return '📞';
    default: return '📬';
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'fax': return 'Fax 📠';
    case 'email': return 'Email ✉️';
    case 'sms': return 'SMS 💬';
    case 'voice': return 'Voice 📞';
    default: return channel;
  }
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function countdown(ts: string | null): string | null {
  if (!ts) return null;
  const diff = Math.max(0, new Date(ts).getTime() - Date.now());
  if (diff === 0) return 'any moment';
  const s = Math.ceil(diff / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.ceil(s / 60)}m`;
}

const QUEUE_KEYS = ['intake', 'referrals', 'roi_incoming', 'roi_outgoing', 'human_review'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Action form state
  const [actionInFlight, setActionInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Escalate to human form
  const [escalateQuestion, setEscalateQuestion] = useState('');
  const [showEscalate, setShowEscalate] = useState(false);

  // Advance stage form
  const [advanceQueue, setAdvanceQueue] = useState('referrals');
  const [showAdvance, setShowAdvance] = useState(false);

  // Send channel form
  type SendChannel = 'fax' | 'email' | 'sms' | 'voice';
  const [sendChannel, setSendChannel] = useState<SendChannel | null>(null);
  const [sendSubject, setSendSubject] = useState('');
  const [sendBody, setSendBody] = useState('');

  // Countdown timer for outbound attempts
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------------------

  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/work-items/${id}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Failed to load');
        return;
      }
      const body = (await res.json()) as WorkItemDetail | { data: WorkItemDetail };
      // Handle both wrapped and unwrapped shapes
      const data = 'data' in body ? (body as { data: WorkItemDetail }).data : body as WorkItemDetail;
      setDetail(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchDetail();
    const interval = setInterval(() => void fetchDetail(), 4000);
    return () => clearInterval(interval);
  }, [fetchDetail]);

  // Countdown ticker for respond_after display
  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Action executor
  // ---------------------------------------------------------------------------

  async function runAction(tool: string, params: Record<string, unknown> = {}) {
    setActionInFlight(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const res = await fetch(`/api/work-items/${id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, params }),
      });
      const body = (await res.json()) as { error?: { message?: string } | string; status?: string; data?: unknown };
      if (!res.ok) {
        const msg = typeof body.error === 'object' && body.error !== null
          ? (body.error as { message?: string }).message ?? JSON.stringify(body.error)
          : (body.error as string) ?? 'Action failed';
        setActionError(msg);
      } else {
        setActionSuccess(`${tool} succeeded`);
        void fetchDetail();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setActionInFlight(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div style={{ padding: '48px 0', color: '#9ca3af', textAlign: 'center' }}>
        Loading work item…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={{ padding: '48px 0', color: '#dc2626', textAlign: 'center' }}>
        {error ?? 'Work item not found'}
      </div>
    );
  }

  const { item, audit, attempts, patientCandidates } = detail;
  const isHumanReview = item.queue_key === 'human_review';
  const confidence = item.confidence ?? {};

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <button
            onClick={() => router.back()}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: '0.85rem',
              padding: 0,
            }}
          >
            &larr; Back
          </button>
          <span style={{ color: '#d1d5db' }}>|</span>
          <span style={{ fontSize: '0.82rem', color: '#9ca3af', fontFamily: 'monospace' }}>{item.id}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, textTransform: 'capitalize' }}>
            {item.type.replace(/_/g, ' ')}
          </h1>
          <span style={{
            padding: '3px 10px',
            borderRadius: '99px',
            fontSize: '0.75rem',
            fontWeight: 600,
            background: item.status === 'done' ? '#d1fae5' : item.status === 'error' ? '#fee2e2' : '#fef3c7',
            color: item.status === 'done' ? '#065f46' : item.status === 'error' ? '#991b1b' : '#92400e',
          }}>
            {item.status}
          </span>
          <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>{item.queue_key}</span>
        </div>
      </div>

      {/* Human Review block */}
      {isHumanReview && (
        <div style={{
          background: '#fff7ed',
          border: '2px solid #fb923c',
          borderRadius: '10px',
          padding: '20px 24px',
          marginBottom: '24px',
        }}>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: '#9a3412', marginBottom: '8px' }}>
            Human Review Required
          </div>
          {item.review_reason && (
            <div style={{ fontSize: '0.95rem', marginBottom: '16px', color: '#431407' }}>
              {item.review_reason}
            </div>
          )}

          {/* Patient candidates */}
          {patientCandidates && patientCandidates.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#7c3aed', marginBottom: '8px' }}>
                Patient Candidates
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {patientCandidates.map((p) => (
                  <div key={p.id} style={{
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    padding: '12px 16px',
                    minWidth: '200px',
                  }}>
                    <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name}</div>
                    <div style={{ fontSize: '0.82rem', color: '#6b7280' }}>DOB: {p.dob}</div>
                    <div style={{ fontSize: '0.82rem', color: '#6b7280' }}>MRN: {p.mrn}</div>
                    <button
                      onClick={() => void runAction('resolve_review', { patientId: p.id })}
                      disabled={actionInFlight}
                      style={{
                        marginTop: '10px',
                        padding: '6px 14px',
                        background: actionInFlight ? '#a5b4fc' : '#4f46e5',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        cursor: actionInFlight ? 'default' : 'pointer',
                      }}
                    >
                      This one
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Free-form resolution */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={() => void runAction('mark_complete', {})}
              disabled={actionInFlight}
              style={btnStyle('#059669', actionInFlight)}
            >
              Mark complete
            </button>
            <button
              onClick={() => {
                setShowEscalate(true);
                setShowAdvance(false);
                setSendChannel(null);
              }}
              disabled={actionInFlight}
              style={btnStyle('#d97706', actionInFlight)}
            >
              Escalate stays human
            </button>
          </div>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Source document fax rendering */}
          {item.source_text && (
            <section style={{
              background: '#fffef5',
              border: '1px solid #d4c89a',
              borderRadius: '8px',
              padding: '20px',
              boxShadow: '2px 2px 8px rgba(0,0,0,0.06)',
            }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#92400e', marginBottom: '10px', letterSpacing: '0.05em' }}>
                SOURCE DOCUMENT (FAX)
              </div>
              <pre style={{
                fontFamily: '"Courier New", Courier, monospace',
                fontSize: '0.78rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
                color: '#1c1917',
                lineHeight: 1.6,
              }}>
                {item.source_text}
              </pre>
            </section>
          )}

          {/* Extracted data */}
          {Object.keys(item.extracted_data ?? {}).length > 0 && (
            <section style={cardStyle}>
              <div style={sectionLabel}>Extracted Data</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
                {Object.entries(item.extracted_data).map(([k, v]) => (
                  <>
                    <span key={`k-${k}`} style={{ fontSize: '0.78rem', color: '#6b7280', fontWeight: 600, padding: '3px 0', textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                      {k.replace(/_/g, ' ')}
                    </span>
                    <span key={`v-${k}`} style={{ fontSize: '0.82rem', color: '#111827', padding: '3px 0' }}>
                      {String(v)}
                    </span>
                  </>
                ))}
              </div>
            </section>
          )}

          {/* Confidence chips */}
          {Object.keys(confidence).length > 0 && (
            <section style={cardStyle}>
              <div style={sectionLabel}>Confidence Scores</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(confidence).map(([step, score]) => (
                  <span key={step} style={{
                    padding: '4px 12px',
                    borderRadius: '99px',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    background: confidenceBg(score),
                    color: confidenceColor(score),
                    border: `1px solid ${confidenceColor(score)}40`,
                  }}>
                    {step}: {(score * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Matched patient */}
          <section style={cardStyle}>
            <div style={sectionLabel}>Patient</div>
            {item.patient ? (
              <div>
                <div style={{ fontWeight: 700 }}>{item.patient.first_name} {item.patient.last_name}</div>
                <div style={{ fontSize: '0.82rem', color: '#6b7280', marginTop: '2px' }}>
                  DOB: {item.patient.dob} &bull; MRN: {item.patient.mrn}
                </div>
              </div>
            ) : (
              <div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Unmatched</div>
            )}
          </section>

          {/* Org */}
          {item.org && (
            <section style={cardStyle}>
              <div style={sectionLabel}>Organization</div>
              <div style={{ fontWeight: 700 }}>{item.org.name}</div>
              {item.org.contact && (
                <div style={{ fontSize: '0.82rem', color: '#6b7280', marginTop: '4px' }}>
                  {item.org.contact.fax && <div>Fax: {item.org.contact.fax}</div>}
                  {item.org.contact.email && <div>Email: {item.org.contact.email}</div>}
                  {item.org.contact.phone && <div>Phone: {item.org.contact.phone}</div>}
                  {item.org.contact.preferred_channel && (
                    <div style={{ marginTop: '4px', color: '#4b5563' }}>
                      Preferred: {item.org.contact.preferred_channel}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Audit timeline */}
          <section style={cardStyle}>
            <div style={sectionLabel}>Audit Timeline</div>
            {audit.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>No events yet.</div>
            ) : (
              <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[...audit].map((entry) => {
                  const badge = actorBadge(entry.actor);
                  const detail = entry.detail ?? {};
                  return (
                    <div key={entry.id} style={{
                      borderLeft: `3px solid ${badge.color}`,
                      paddingLeft: '12px',
                      paddingTop: '2px',
                      paddingBottom: '2px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '99px',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          background: badge.bg,
                          color: badge.color,
                        }}>
                          {badge.label}
                        </span>
                        <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>{entry.action}</span>
                        <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginLeft: 'auto' }}>
                          {fmtTime(entry.created_at)}
                        </span>
                      </div>
                      {!!detail.rationale && (
                        <div style={{ fontSize: '0.78rem', color: '#4b5563', marginTop: '4px', fontStyle: 'italic' }}>
                          {String(detail.rationale)}
                        </div>
                      )}
                      {typeof detail.confidence === 'number' && (
                        <div style={{ fontSize: '0.75rem', marginTop: '2px' }}>
                          <span style={{
                            color: confidenceColor(detail.confidence as number),
                            fontWeight: 700,
                          }}>
                            {((detail.confidence as number) * 100).toFixed(0)}% confidence
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Outbound attempts */}
          {attempts.length > 0 && (
            <section style={cardStyle}>
              <div style={sectionLabel}>Outbound Attempts</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {attempts.map((att) => {
                  const sb = statusBadge(att.status);
                  const cd = countdown(att.respond_after);
                  return (
                    <div key={att.id} style={{
                      background: '#f9fafb',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      padding: '12px 16px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '1.1rem' }}>{channelIcon(att.channel)}</span>
                        <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>
                          {channelLabel(att.channel)} — Attempt #{att.attempt_no}
                        </span>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '99px',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          background: sb.bg,
                          color: sb.color,
                        }}>
                          {att.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {!!(att.payload && att.payload.subject) && (
                        <div style={{ fontSize: '0.78rem', color: '#4b5563', marginTop: '6px' }}>
                          Subject: {String(att.payload.subject)}
                        </div>
                      )}
                      {att.status === 'awaiting_response' && cd && (
                        <div style={{ fontSize: '0.75rem', color: '#d97706', marginTop: '4px' }}>
                          Response expected in {cd}
                        </div>
                      )}
                      {att.response && Object.keys(att.response).length > 0 && (
                        <div style={{
                          marginTop: '8px',
                          padding: '8px 10px',
                          background: '#f0fdf4',
                          border: '1px solid #bbf7d0',
                          borderRadius: '6px',
                          fontSize: '0.78rem',
                          color: '#065f46',
                        }}>
                          Response: {att.response.summary
                            ? String(att.response.summary)
                            : JSON.stringify(att.response)}
                        </div>
                      )}
                      <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: '4px' }}>
                        {fmtTime(att.created_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Manual Actions bar */}
      <section style={{
        ...cardStyle,
        marginTop: '28px',
        background: '#f8fafc',
        border: '1px solid #cbd5e1',
      }}>
        <div style={sectionLabel}>Manual Actions</div>

        {actionError && (
          <div style={{
            background: '#fee2e2',
            border: '1px solid #fca5a5',
            borderRadius: '6px',
            padding: '8px 14px',
            color: '#991b1b',
            fontSize: '0.82rem',
            marginBottom: '12px',
          }}>
            {actionError}
          </div>
        )}
        {actionSuccess && (
          <div style={{
            background: '#d1fae5',
            border: '1px solid #6ee7b7',
            borderRadius: '6px',
            padding: '8px 14px',
            color: '#065f46',
            fontSize: '0.82rem',
            marginBottom: '12px',
          }}>
            {actionSuccess}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
          {/* Advance stage */}
          <button
            onClick={() => {
              setShowAdvance(!showAdvance);
              setShowEscalate(false);
              setSendChannel(null);
            }}
            disabled={actionInFlight}
            style={btnStyle('#1e3a5f', actionInFlight)}
          >
            Advance stage
          </button>

          {/* Send channels */}
          {(['fax', 'email', 'sms', 'voice'] as const).map((ch) => (
            <button
              key={ch}
              onClick={() => {
                setSendChannel(sendChannel === ch ? null : ch);
                setShowAdvance(false);
                setShowEscalate(false);
              }}
              disabled={actionInFlight}
              style={btnStyle('#0891b2', actionInFlight)}
            >
              {channelLabel(ch)}
            </button>
          ))}

          {/* Other quick actions */}
          <button
            onClick={() => void runAction('request_more_info', {})}
            disabled={actionInFlight}
            style={btnStyle('#7c3aed', actionInFlight)}
          >
            Request more info
          </button>
          <button
            onClick={() => void runAction('mark_complete', {})}
            disabled={actionInFlight}
            style={btnStyle('#059669', actionInFlight)}
          >
            Mark complete
          </button>
          <button
            onClick={() => {
              setShowEscalate(!showEscalate);
              setShowAdvance(false);
              setSendChannel(null);
            }}
            disabled={actionInFlight}
            style={btnStyle('#dc2626', actionInFlight)}
          >
            Escalate to human
          </button>
        </div>

        {/* Advance stage form */}
        {showAdvance && (
          <div style={inlineFormStyle}>
            <select
              value={advanceQueue}
              onChange={(e) => setAdvanceQueue(e.target.value)}
              style={selectStyle}
            >
              {QUEUE_KEYS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <button
              onClick={() => {
                void runAction('advance_stage', { queue_key: advanceQueue });
                setShowAdvance(false);
              }}
              disabled={actionInFlight}
              style={btnStyle('#1e3a5f', actionInFlight)}
            >
              Confirm advance
            </button>
          </div>
        )}

        {/* Send channel form */}
        {sendChannel && (
          <div style={inlineFormStyle}>
            <input
              placeholder="Subject"
              value={sendSubject}
              onChange={(e) => setSendSubject(e.target.value)}
              style={inputStyle}
            />
            <textarea
              placeholder="Message body"
              value={sendBody}
              onChange={(e) => setSendBody(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <button
              onClick={() => {
                void runAction(`send_${sendChannel}`, {
                  subject: sendSubject,
                  body: sendBody,
                  org_id: item.org_id ?? undefined,
                });
                setSendChannel(null);
                setSendSubject('');
                setSendBody('');
              }}
              disabled={actionInFlight || !sendSubject}
              style={btnStyle('#0891b2', actionInFlight || !sendSubject)}
            >
              Send {sendChannel}
            </button>
          </div>
        )}

        {/* Escalate to human form */}
        {showEscalate && (
          <div style={inlineFormStyle}>
            <input
              placeholder="What question needs human judgment?"
              value={escalateQuestion}
              onChange={(e) => setEscalateQuestion(e.target.value)}
              style={inputStyle}
            />
            <button
              onClick={() => {
                void runAction('escalate_to_human', { question: escalateQuestion });
                setShowEscalate(false);
                setEscalateQuestion('');
              }}
              disabled={actionInFlight || !escalateQuestion}
              style={btnStyle('#dc2626', actionInFlight || !escalateQuestion)}
            >
              Escalate
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function btnStyle(bg: string, disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: disabled ? '#d1d5db' : bg,
    color: disabled ? '#9ca3af' : '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    whiteSpace: 'nowrap',
  };
}

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  padding: '18px 20px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
};

const sectionLabel: React.CSSProperties = {
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: '#9ca3af',
  marginBottom: '12px',
};

const inlineFormStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '14px',
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  maxWidth: '440px',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.85rem',
  background: '#fff',
};

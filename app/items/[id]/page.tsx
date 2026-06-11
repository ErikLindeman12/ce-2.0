'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { WorkItem, AuditLogEntry, OutboundAttempt, Patient } from '@/lib/types';

// ---------------------------------------------------------------------------
// Extended types
// ---------------------------------------------------------------------------

interface ChasePlan {
  channels: string[];
  waitSeconds: number;
}

interface AgentState {
  chase_plan?: ChasePlan;
  attempt_no?: number;
  last_channel?: string;
  kind?: string;
}

interface WorkItemDetail {
  item: WorkItem & {
    sourceText?: string;
    source_text?: string;
    agentState?: AgentState | Record<string, unknown>;
    agent_state?: AgentState | Record<string, unknown>;
  };
  audit: AuditLogEntry[];
  auditTrail?: AuditLogEntry[];
  attempts: OutboundAttempt[];
  outboundAttempts?: OutboundAttempt[];
  patientCandidates: Patient[];
}

// Attempts carry payload.document and richer response
interface AttemptWithDoc extends OutboundAttempt {
  payload: {
    document?: string;
    subject?: string;
    body?: string;
    kind?: string;
    [key: string]: unknown;
  };
  response: {
    summary?: string;
    message?: string;
    document?: string;
    outcome?: string;
    note?: string;
    status?: string;
    received_at?: string;
    authorization?: string;
    [key: string]: unknown;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
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

function confidenceColor(score: number) {
  if (score >= 0.8) return 'var(--color-success)';
  if (score >= 0.5) return 'var(--color-warning)';
  return 'var(--color-error)';
}
function confidenceBg(score: number) {
  if (score >= 0.8) return 'var(--color-success-bg)';
  if (score >= 0.5) return 'var(--color-warning-bg)';
  return 'var(--color-error-bg)';
}

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function countdown(ts: string | null): string | null {
  if (!ts) return null;
  const diff = Math.max(0, new Date(ts).getTime() - Date.now());
  if (diff === 0) return 'any moment';
  const s = Math.ceil(diff / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.ceil(s / 60)}m`;
}

// The API serves camelCase; parts of this page read snake_case. Add snake
// aliases recursively so every read site works with either shape.
const CAMEL_TO_SNAKE: Record<string, string> = {
  createdAt: 'created_at', updatedAt: 'updated_at', attemptNo: 'attempt_no',
  respondAfter: 'respond_after', reviewReason: 'review_reason',
  queueKey: 'queue_key', sourceText: 'source_text', agentState: 'agent_state',
  extractedData: 'extracted_data', sourceChannel: 'source_channel',
  matchedPatientId: 'matched_patient_id', firstName: 'first_name',
  lastName: 'last_name', toContact: 'to_contact', workItemId: 'work_item_id',
};

function aliasKeys<T>(v: T): T {
  if (Array.isArray(v)) {
    v.forEach(aliasKeys);
    return v;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
      if (camel in o && !(snake in o)) o[snake] = o[camel];
    }
    for (const k of ['patient', 'org']) {
      if (o[k] && typeof o[k] === 'object') aliasKeys(o[k]);
    }
  }
  return v;
}

function getAgentState(item: WorkItemDetail['item']): AgentState {
  const raw = (item.agentState ?? item.agent_state ?? {}) as AgentState;
  return raw;
}

function getSourceText(item: WorkItemDetail['item']): string | null {
  return item.sourceText ?? item.source_text ?? null;
}

const QUEUE_KEYS = ['intake', 'referrals', 'roi_incoming', 'roi_outgoing', 'human_review'];

// ---------------------------------------------------------------------------
// Chase stepper header
// ---------------------------------------------------------------------------

function ChaseStepperHeader({
  agentState,
  attempts,
  itemStatus,
}: {
  agentState: AgentState;
  attempts: AttemptWithDoc[];
  itemStatus: string;
}) {
  const plan = agentState.chase_plan;
  if (!plan || !plan.channels || plan.channels.length === 0) return null;

  const isDone = itemStatus === 'done';
  const isHumanReview = itemStatus === 'human_review' || false;
  const attemptNo = agentState.attempt_no ?? attempts.length;

  return (
    <div className="card" style={{ marginBottom: '24px', padding: '16px 20px' }}>
      <div className="section-label">Chase Plan — {plan.channels.length} channel{plan.channels.length !== 1 ? 's' : ''}, {plan.waitSeconds}s wait</div>
      <div className="stepper">
        {plan.channels.map((ch, i) => {
          const chIdx = i + 1;
          // Determine step state from attempts
          const attForChannel = attempts.filter((a) => a.channel === ch);
          const lastAtt = attForChannel[attForChannel.length - 1];

          let stepClass = '';
          let icon = CHANNEL_ICONS[ch] ?? '?';
          let stateLabel = '';

          if (lastAtt) {
            if (lastAtt.status === 'responded') {
              stepClass = 'done';
              stateLabel = '✓';
            } else if (lastAtt.status === 'timed_out' || lastAtt.status === 'failed') {
              stepClass = 'failed';
              stateLabel = '✗';
            } else if (lastAtt.status === 'awaiting_response' || lastAtt.status === 'sent') {
              stepClass = 'active';
              stateLabel = '●';
            }
          } else if (isDone && chIdx <= attemptNo) {
            stepClass = 'done';
            stateLabel = '✓';
          } else if ((isHumanReview) && chIdx <= attemptNo) {
            stepClass = 'failed';
            stateLabel = '✗';
          }

          return (
            <span key={ch} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span
                className={`stepper-step ${stepClass}`}
                title={`${CHANNEL_LABELS[ch] ?? ch}${stateLabel ? ' — ' + stateLabel : ''}`}
              >
                <span>{icon}</span>
                <span>{CHANNEL_LABELS[ch] ?? ch}</span>
                {stateLabel && <span>{stateLabel}</span>}
              </span>
              {i < plan.channels.length - 1 && (
                <span className="stepper-arrow">→ {plan.waitSeconds}s →</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fax paper card (document viewer)
// ---------------------------------------------------------------------------

function DocumentExpander({ document, label }: { document: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: '8px' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-accent)',
          cursor: 'pointer',
          fontSize: '0.78rem',
          fontWeight: 600,
          padding: '2px 0',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        {open ? '▾' : '▸'} {label ?? 'View document'}
      </button>
      {open && (
        <div className="card-paper" style={{ marginTop: '8px', maxHeight: '340px', overflowY: 'auto', fontSize: '0.76rem' }}>
          {document}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attempt card
// ---------------------------------------------------------------------------

function AttemptCard({ att, index }: { att: AttemptWithDoc; index: number }) {
  const sb = statusBadgeProps(att.status);
  const cd = countdown(att.respond_after ?? (att as unknown as { respondAfter?: string }).respondAfter ?? null);
  const doc = att.payload?.document;
  const response = att.response;

  const isPortalChannel = att.channel === 'portal';
  const isVoiceNoAnswer = response?.outcome === 'no_answer';

  return (
    <div
      style={{
        background: 'var(--color-bg)',
        border: `1px solid var(--color-border)`,
        borderLeft: `3px solid ${sb.borderColor}`,
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1.1rem' }}>{CHANNEL_ICONS[att.channel] ?? '📬'}</span>
        <span style={{ fontSize: '0.88rem', fontWeight: 700 }}>
          {CHANNEL_LABELS[att.channel] ?? att.channel}
          {' '}— Attempt #{att.attempt_no ?? (index + 1)}
        </span>
        <span
          className={`badge ${sb.badgeClass}`}
        >
          {att.status.replace(/_/g, ' ')}
        </span>
        {att.status === 'awaiting_response' && cd && (
          <span style={{ fontSize: '0.74rem', color: 'var(--color-warning)', fontWeight: 600, marginLeft: 'auto' }}>
            ⏱ response or timeout in ~{cd}
          </span>
        )}
      </div>

      {/* Subject */}
      {!!att.payload?.subject && (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-ink-muted)', marginTop: '6px' }}>
          Subject: {String(att.payload.subject)}
        </div>
      )}

      {/* Document expander */}
      {doc && typeof doc === 'string' && doc.trim() && (
        <DocumentExpander document={doc} label={`View ${CHANNEL_LABELS[att.channel] ?? att.channel} document`} />
      )}

      {/* Response block */}
      {response && Object.keys(response).length > 0 && (
        <div
          style={{
            marginTop: '10px',
            padding: '10px 12px',
            background: isVoiceNoAnswer ? 'var(--color-warning-bg)' : 'var(--color-success-bg)',
            border: `1px solid ${isVoiceNoAnswer ? '#fde68a' : '#bbf7d0'}`,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div className="section-label" style={{ marginBottom: '6px' }}>
            Response {isPortalChannel ? '(via portal)' : ''}
          </div>

          {/* Voice no-answer outcome */}
          {isVoiceNoAnswer && (
            <div style={{ fontSize: '0.80rem', color: 'var(--color-warning)', fontWeight: 600 }}>
              No answer — {response.note ?? 'Call attempted; voicemail left.'}
            </div>
          )}

          {/* Message */}
          {!isVoiceNoAnswer && response.message && (
            <div style={{ fontSize: '0.82rem', color: 'var(--color-ink)' }}>
              {String(response.message)}
            </div>
          )}

          {/* Response document (received records transmittal) */}
          {response.document && typeof response.document === 'string' && (
            <DocumentExpander
              document={response.document}
              label="View records transmittal"
            />
          )}

          {/* Authorization note */}
          {response.authorization && (
            <div style={{ fontSize: '0.78rem', color: 'var(--color-success)', marginTop: '4px' }}>
              {String(response.authorization)}
            </div>
          )}

          {/* Received timestamp */}
          {response.received_at && (
            <div style={{ fontSize: '0.72rem', color: 'var(--color-ink-faint)', marginTop: '4px' }}>
              Received: {fmtTime(String(response.received_at))}
            </div>
          )}

          {/* Fallback: show summary or raw if nothing else matched */}
          {!isVoiceNoAnswer && !response.message && !response.document && !response.authorization && (
            <div style={{ fontSize: '0.78rem', color: 'var(--color-ink-muted)' }}>
              {response.summary ? String(response.summary) : JSON.stringify(response)}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: '0.72rem', color: 'var(--color-ink-faint)', marginTop: '6px' }}>
        {fmtTime(att.created_at)}
      </div>
    </div>
  );
}

function statusBadgeProps(status: string): { badgeClass: string; borderColor: string } {
  switch (status) {
    case 'sent':             return { badgeClass: 'badge-info',    borderColor: 'var(--color-info)' };
    case 'awaiting_response':return { badgeClass: 'badge-warning', borderColor: 'var(--color-warning)' };
    case 'responded':        return { badgeClass: 'badge-success', borderColor: 'var(--color-success)' };
    case 'timed_out':        return { badgeClass: 'badge-error',   borderColor: 'var(--color-error)' };
    case 'failed':           return { badgeClass: 'badge-error',   borderColor: 'var(--color-error)' };
    default:                 return { badgeClass: 'badge-neutral', borderColor: 'var(--color-border)' };
  }
}

// ---------------------------------------------------------------------------
// Audit timeline
// ---------------------------------------------------------------------------

function AuditTimeline({ audit }: { audit: AuditLogEntry[] }) {
  if (audit.length === 0) {
    return (
      <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.82rem' }}>
        No events yet.
      </div>
    );
  }

  return (
    <div className="audit-rail" style={{ maxHeight: '380px', overflowY: 'auto' }}>
      {[...audit].map((entry) => {
        const isPortal = entry.actor.startsWith('portal:');
        const isAgent = entry.actor.startsWith('agent:');
        const isHuman = entry.actor === 'human';

        let dotColor = 'var(--color-ink-faint)';
        let badgeClass = 'badge-neutral';
        let label = entry.actor;

        if (isPortal) {
          dotColor = 'var(--color-portal)';
          badgeClass = 'badge-portal';
          label = entry.actor;
        } else if (isAgent) {
          dotColor = 'var(--color-accent)';
          badgeClass = 'badge-accent';
          label = entry.actor.replace('agent:', '');
        } else if (isHuman) {
          dotColor = 'var(--color-success)';
          badgeClass = 'badge-success';
          label = 'Human';
        }

        const detail = entry.detail ?? {};

        return (
          <div key={entry.id} className="audit-entry">
            <div className="audit-dot" style={{ color: dotColor }} />
            <div className="audit-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`badge ${badgeClass}`} style={{ fontSize: '0.70rem' }}>
                  {label}
                </span>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>{entry.action}</span>
                <span style={{ fontSize: '0.74rem', color: 'var(--color-ink-faint)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {fmtTime(entry.created_at)}
                </span>
              </div>
              {!!detail.rationale && (
                <div style={{ fontSize: '0.76rem', color: 'var(--color-ink-muted)', marginTop: '3px', fontStyle: 'italic' }}>
                  {String(detail.rationale)}
                </div>
              )}
              {typeof detail.confidence === 'number' && (
                <div style={{ fontSize: '0.74rem', marginTop: '2px', color: confidenceColor(detail.confidence as number), fontWeight: 700 }}>
                  {((detail.confidence as number) * 100).toFixed(0)}% confidence
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button helper
// ---------------------------------------------------------------------------

function btnStyle(bg: string, disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: disabled ? 'var(--color-border)' : bg,
    color: disabled ? 'var(--color-ink-faint)' : '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background var(--transition)',
    opacity: disabled ? 0.6 : 1,
  };
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [actionInFlight, setActionInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const [escalateQuestion, setEscalateQuestion] = useState('');
  const [showEscalate, setShowEscalate] = useState(false);
  const [advanceQueue, setAdvanceQueue] = useState('referrals');
  const [showAdvance, setShowAdvance] = useState(false);

  type SendChannel = 'fax' | 'email' | 'sms' | 'voice';
  const [sendChannel, setSendChannel] = useState<SendChannel | null>(null);
  const [sendSubject, setSendSubject] = useState('');
  const [sendBody, setSendBody] = useState('');

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
      const body = (await res.json()) as Record<string, unknown>;
      const raw = (body['data'] ?? body) as Record<string, unknown>;
      const data: WorkItemDetail = {
        item: aliasKeys(raw['item']) as WorkItemDetail['item'],
        audit:             aliasKeys((raw['audit']            ?? raw['auditTrail']       ?? [])) as AuditLogEntry[],
        attempts:          aliasKeys((raw['attempts']         ?? raw['outboundAttempts'] ?? [])) as OutboundAttempt[],
        patientCandidates: aliasKeys((raw['patientCandidates'] ?? [])) as Patient[],
      };
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

  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
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
      const body = (await res.json()) as { error?: { message?: string } | string; status?: string };
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
  // Loading / error
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div style={{ padding: '64px 0', color: 'var(--color-ink-faint)', textAlign: 'center', fontSize: '0.88rem' }}>
        Loading work item…
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div style={{ padding: '64px 0', color: 'var(--color-error)', textAlign: 'center' }}>
        {error ?? 'Work item not found'}
      </div>
    );
  }

  const { item, audit, attempts, patientCandidates } = detail;
  const isHumanReview = item.queue_key === 'human_review';
  const isOutbound = item.type === 'records_request_out';
  const confidence = item.confidence ?? {};
  const agentState = getAgentState(item);
  const sourceText = getSourceText(item);
  const typedAttempts = attempts as AttemptWithDoc[];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <button
            onClick={() => router.back()}
            style={{
              background: 'none', border: 'none', color: 'var(--color-ink-muted)',
              cursor: 'pointer', fontSize: '0.84rem', padding: 0, display: 'inline-flex', alignItems: 'center', gap: '4px',
            }}
          >
            ← Back
          </button>
          <span style={{ color: 'var(--color-border-strong)' }}>|</span>
          <code style={{ fontSize: '0.76rem', color: 'var(--color-ink-faint)', fontFamily: 'monospace', background: '#f1f3f6', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>
            {item.id}
          </code>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, textTransform: 'capitalize', color: 'var(--color-ink)' }}>
            {item.type.replace(/_/g, ' ')}
          </h1>
          <span
            className={`badge ${
              item.status === 'done'  ? 'badge-success' :
              item.status === 'error' ? 'badge-error' :
              item.status === 'waiting' ? 'badge-accent' :
              'badge-warning'
            }`}
            style={{ padding: '4px 12px', fontSize: '0.80rem' }}
          >
            {item.status}
          </span>
          <span style={{ fontSize: '0.80rem', color: 'var(--color-ink-faint)' }}>{item.queue_key}</span>
        </div>
      </div>

      {/* Chase stepper — only for outbound items */}
      {isOutbound && (
        <ChaseStepperHeader
          agentState={agentState}
          attempts={typedAttempts}
          itemStatus={item.status}
        />
      )}

      {/* Human Review block */}
      {isHumanReview && (
        <div
          style={{
            background: '#fff7ed',
            border: '2px solid #fb923c',
            borderRadius: 'var(--radius)',
            padding: '20px 24px',
            marginBottom: '24px',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '1rem', color: '#9a3412', marginBottom: '8px' }}>
            Human Review Required
          </div>
          {item.review_reason && (
            <div style={{ fontSize: '0.92rem', marginBottom: '16px', color: '#431407', lineHeight: 1.5 }}>
              {item.review_reason}
            </div>
          )}

          {patientCandidates && patientCandidates.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div className="section-label">Patient Candidates</div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {patientCandidates.map((p) => (
                  <div key={p.id} className="card" style={{ minWidth: '180px', padding: '12px 16px' }}>
                    <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name}</div>
                    <div style={{ fontSize: '0.80rem', color: 'var(--color-ink-muted)' }}>DOB: {p.dob}</div>
                    <div style={{ fontSize: '0.80rem', color: 'var(--color-ink-muted)' }}>MRN: {p.mrn}</div>
                    <button
                      onClick={() => void runAction('resolve_review', { patientId: p.id })}
                      disabled={actionInFlight}
                      style={{ ...btnStyle('var(--color-accent)', actionInFlight), marginTop: '10px' }}
                    >
                      This one
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button onClick={() => void runAction('mark_complete', {})} disabled={actionInFlight} style={btnStyle('var(--color-success)', actionInFlight)}>
              Mark complete
            </button>
            <button
              onClick={() => { setShowEscalate(true); setShowAdvance(false); setSendChannel(null); }}
              disabled={actionInFlight}
              style={btnStyle('var(--color-warning)', actionInFlight)}
            >
              Escalate stays human
            </button>
          </div>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>

        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

          {/* Source document — fax-paper treatment */}
          {sourceText && (
            <section>
              <div className="section-label">Source Document (Fax)</div>
              <div className="card-paper">
                {sourceText}
              </div>
            </section>
          )}

          {/* Extracted data */}
          {Object.keys(item.extracted_data ?? {}).length > 0 && (
            <section className="card">
              <div className="section-label">Extracted Data</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 16px' }}>
                {Object.entries(item.extracted_data).map(([k, v]) => (
                  <>
                    <span key={`k-${k}`} style={{ fontSize: '0.77rem', color: 'var(--color-ink-muted)', fontWeight: 600, padding: '3px 0', textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                      {k.replace(/_/g, ' ')}
                    </span>
                    <span key={`v-${k}`} style={{ fontSize: '0.82rem', color: 'var(--color-ink)', padding: '3px 0' }}>
                      {String(v)}
                    </span>
                  </>
                ))}
              </div>
            </section>
          )}

          {/* Confidence chips */}
          {Object.keys(confidence).length > 0 && (
            <section className="card">
              <div className="section-label">Confidence Scores</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(confidence).map(([step, score]) => (
                  <span
                    key={step}
                    style={{
                      padding: '4px 12px',
                      borderRadius: '99px',
                      fontSize: '0.77rem',
                      fontWeight: 700,
                      background: confidenceBg(score),
                      color: confidenceColor(score),
                      border: `1px solid ${confidenceColor(score)}40`,
                    }}
                  >
                    {step}: {(score * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Patient */}
          <section className="card">
            <div className="section-label">Patient</div>
            {item.patient ? (
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                  {item.patient.first_name} {item.patient.last_name}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--color-ink-muted)', marginTop: '2px' }}>
                  DOB: {item.patient.dob} &bull; MRN: {item.patient.mrn}
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.84rem' }}>Unmatched</div>
            )}
          </section>

          {/* Organization */}
          {item.org && (
            <section className="card">
              <div className="section-label">Organization</div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{item.org.name}</div>
              {item.org.contact && (
                <div style={{ fontSize: '0.82rem', color: 'var(--color-ink-muted)', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {item.org.contact.fax   && <span>📠 {item.org.contact.fax}</span>}
                  {item.org.contact.email && <span>✉️ {item.org.contact.email}</span>}
                  {item.org.contact.phone && <span>📞 {item.org.contact.phone}</span>}
                  {item.org.contact.preferred_channel && (
                    <span style={{ marginTop: '4px' }}>
                      <span className={`badge ${item.org.contact.preferred_channel === 'portal' ? 'badge-portal' : 'badge-neutral'}`}>
                        {item.org.contact.preferred_channel === 'portal' ? '🌐 On network' : `Preferred: ${item.org.contact.preferred_channel}`}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* RIGHT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

          {/* Audit timeline */}
          <section className="card">
            <div className="section-label">Audit Timeline</div>
            <AuditTimeline audit={audit} />
          </section>

          {/* Outbound attempts */}
          {typedAttempts.length > 0 ? (
            <section className="card">
              <div className="section-label">
                Outbound Attempts ({typedAttempts.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {typedAttempts.map((att, i) => (
                  <AttemptCard key={att.id} att={att} index={i} />
                ))}
              </div>
            </section>
          ) : isOutbound ? (
            <section className="card" style={{ textAlign: 'center', padding: '32px 20px' }}>
              <div style={{ fontSize: '1.6rem', marginBottom: '8px' }}>📤</div>
              <div className="section-label" style={{ marginBottom: '4px' }}>No outbound attempts yet</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--color-ink-faint)' }}>
                The agent sends on the next tick.
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Manual Actions bar */}
      <section
        className="card"
        style={{ marginTop: '28px', background: '#f8fafc', border: '1px solid var(--color-border-strong)' }}
      >
        <div className="section-label">Manual Actions</div>

        {actionError && (
          <div
            style={{
              background: 'var(--color-error-bg)',
              border: '1px solid #fca5a5',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 14px',
              color: 'var(--color-error)',
              fontSize: '0.82rem',
              marginBottom: '12px',
            }}
          >
            {actionError}
          </div>
        )}
        {actionSuccess && (
          <div
            style={{
              background: 'var(--color-success-bg)',
              border: '1px solid #6ee7b7',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 14px',
              color: 'var(--color-success)',
              fontSize: '0.82rem',
              marginBottom: '12px',
            }}
          >
            {actionSuccess}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => { setShowAdvance(!showAdvance); setShowEscalate(false); setSendChannel(null); }}
            disabled={actionInFlight}
            style={btnStyle('#1e3a5f', actionInFlight)}
          >
            Advance stage
          </button>
          {(['fax', 'email', 'sms', 'voice'] as const).map((ch) => (
            <button
              key={ch}
              onClick={() => { setSendChannel(sendChannel === ch ? null : ch); setShowAdvance(false); setShowEscalate(false); }}
              disabled={actionInFlight}
              style={btnStyle('#0891b2', actionInFlight)}
            >
              {CHANNEL_ICONS[ch]} {ch}
            </button>
          ))}
          <button onClick={() => void runAction('request_more_info', {})} disabled={actionInFlight} style={btnStyle('#7c3aed', actionInFlight)}>
            Request more info
          </button>
          <button onClick={() => void runAction('mark_complete', {})} disabled={actionInFlight} style={btnStyle('var(--color-success)', actionInFlight)}>
            Mark complete
          </button>
          <button
            onClick={() => { setShowEscalate(!showEscalate); setShowAdvance(false); setSendChannel(null); }}
            disabled={actionInFlight}
            style={btnStyle('var(--color-error)', actionInFlight)}
          >
            Escalate to human
          </button>
        </div>

        {/* Advance stage form */}
        {showAdvance && (
          <div style={inlineFormStyle}>
            <select value={advanceQueue} onChange={(e) => setAdvanceQueue(e.target.value)} style={selectStyle}>
              {QUEUE_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button
              onClick={() => { void runAction('advance_stage', { queue_key: advanceQueue }); setShowAdvance(false); }}
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
                void runAction(`send_${sendChannel}`, { subject: sendSubject, body: sendBody, org_id: item.org_id ?? undefined });
                setSendChannel(null); setSendSubject(''); setSendBody('');
              }}
              disabled={actionInFlight || !sendSubject}
              style={btnStyle('#0891b2', actionInFlight || !sendSubject)}
            >
              Send {sendChannel}
            </button>
          </div>
        )}

        {/* Escalate form */}
        {showEscalate && (
          <div style={inlineFormStyle}>
            <input
              placeholder="What question needs human judgment?"
              value={escalateQuestion}
              onChange={(e) => setEscalateQuestion(e.target.value)}
              style={inputStyle}
            />
            <button
              onClick={() => { void runAction('escalate_to_human', { question: escalateQuestion }); setShowEscalate(false); setEscalateQuestion(''); }}
              disabled={actionInFlight || !escalateQuestion}
              style={btnStyle('var(--color-error)', actionInFlight || !escalateQuestion)}
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

const inlineFormStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '14px',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)',
  maxWidth: '440px',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.84rem',
  fontFamily: 'inherit',
  width: '100%',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.84rem',
  background: 'var(--color-surface)',
  width: '100%',
};

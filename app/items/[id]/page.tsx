'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { WorkItem, AuditLogEntry, OutboundAttempt, Patient } from '@/lib/types';

// ---------------------------------------------------------------------------
// Extended types
// ---------------------------------------------------------------------------

interface ChaseStep {
  channel: string;
  attempt: number;
}

interface ChasePlan {
  // New shape: steps with attempt numbers
  steps?: ChaseStep[];
  // Legacy shape: flat channel array
  channels?: string[];
  waitSeconds: number;
}

interface ExtractionFieldMeta {
  confidence: number;
  sourceLine: number;
}

interface ExtractionMeta {
  fields: Record<string, ExtractionFieldMeta>;
}

interface PendingApproval {
  action: string;
  params: Record<string, unknown>;
  confidence: number;
  rationale: string;
  agentId: string;
  agentName: string;
}

interface AgentState {
  chase_plan?: ChasePlan;
  attempt_no?: number;
  last_channel?: string;
  kind?: string;
  extraction_meta?: ExtractionMeta;
  pending_approval?: PendingApproval;
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
  fax:            '📠',
  email:          '✉️',
  sms:            '💬',
  voice:          '📞',
  phone:          '📞',
  portal:         '🌐',
  care_everywhere:'⚡',
};

const CHANNEL_LABELS: Record<string, string> = {
  fax:            'Fax',
  email:          'Secure Email',
  sms:            'SMS',
  voice:          'Voice',
  phone:          'Phone',
  portal:         'In-app',
  care_everywhere:'Care Everywhere',
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
// Approval banner — shown when agent_state.pending_approval exists
// ---------------------------------------------------------------------------

function ApprovalBanner({
  approval,
  itemId,
  onSettled,
}: {
  approval: PendingApproval;
  itemId: string;
  onSettled: () => void;
}) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(tool: 'approve_action' | 'reject_action') {
    setInFlight(true);
    setError(null);
    try {
      const res = await fetch(`/api/work-items/${itemId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, params: {} }),
      });
      const body = (await res.json()) as { error?: string | { message?: string } };
      if (!res.ok) {
        const msg = typeof body.error === 'object' && body.error !== null
          ? (body.error as { message?: string }).message ?? JSON.stringify(body.error)
          : (body.error as string) ?? 'Action failed';
        setError(msg);
      } else {
        onSettled();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setInFlight(false);
    }
  }

  // Build a brief params summary (subject / body preview for sends; key=value otherwise)
  const paramSummary = (() => {
    const p = approval.params;
    if (!p || Object.keys(p).length === 0) return null;
    const parts: string[] = [];
    if (typeof p.subject === 'string') parts.push(`Subject: "${p.subject.slice(0, 60)}"`);
    if (typeof p.body === 'string') parts.push(`Body: "${p.body.slice(0, 80)}…"`);
    if (parts.length === 0) {
      for (const [k, v] of Object.entries(p).slice(0, 3)) {
        parts.push(`${k}: ${String(v).slice(0, 40)}`);
      }
    }
    return parts.join(' · ');
  })();

  return (
    <div className="approval-banner">
      <div className="approval-banner-header">
        <span className="approval-banner-icon">🤖</span>
        <div style={{ flex: 1 }}>
          <div className="approval-banner-title">
            <strong>{approval.agentName}</strong> proposes:{' '}
            <span className="approval-banner-action">{approval.action}</span>
            {' '}
            <span className="approval-banner-confidence">
              confidence {(approval.confidence * 100).toFixed(0)}%
            </span>
          </div>
          {approval.rationale && (
            <div className="approval-banner-rationale">{approval.rationale}</div>
          )}
          {paramSummary && (
            <div className="approval-banner-params">{paramSummary}</div>
          )}
        </div>
        <div className="approval-banner-actions">
          <button
            onClick={() => void act('approve_action')}
            disabled={inFlight}
            className="approval-btn approval-btn-approve"
          >
            {inFlight ? '…' : 'Approve'}
          </button>
          <button
            onClick={() => void act('reject_action')}
            disabled={inFlight}
            className="approval-btn approval-btn-reject"
          >
            Reject
          </button>
        </div>
      </div>
      {error && (
        <div className="approval-banner-error">{error}</div>
      )}
    </div>
  );
}

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
  if (!plan) return null;

  // Normalize to a steps array — handle both new {steps} and legacy {channels} shapes
  type NormStep = { channel: string; attempt: number };
  let steps: NormStep[];
  if (plan.steps && plan.steps.length > 0) {
    steps = plan.steps;
  } else if (plan.channels && plan.channels.length > 0) {
    const counts: Record<string, number> = {};
    steps = plan.channels.map((ch) => {
      counts[ch] = (counts[ch] ?? 0) + 1;
      return { channel: ch, attempt: counts[ch] };
    });
  } else {
    return null;
  }

  if (steps.length === 0) return null;

  const isDone = itemStatus === 'done';
  const isHumanReview = itemStatus === 'human_review' || false;
  const attemptNo = agentState.attempt_no ?? attempts.length;

  const isCE = steps.length === 1 && steps[0].channel === 'care_everywhere';

  // Count repeats to know whether to show "(1st)/(2nd)" labels
  const channelCounts: Record<string, number> = {};
  for (const s of steps) channelCounts[s.channel] = (channelCounts[s.channel] ?? 0) + 1;
  const hasRepeats = Object.values(channelCounts).some((c) => c > 1);

  const ordinals = ['1st', '2nd', '3rd', '4th'];

  return (
    <div className="card" style={{ marginBottom: '24px', padding: '16px 20px' }}>
      <div className="section-label">
        {isCE
          ? 'Care Everywhere — structured exchange'
          : `Chase Plan — ${steps.length} step${steps.length !== 1 ? 's' : ''}, ${plan.waitSeconds}s wait`}
      </div>
      <div className="stepper">
        {steps.map((s, i) => {
          // Match attempt cards by channel + attempt number where possible
          const attForChannel = attempts.filter((a) => a.channel === s.channel);
          // attempt is 1-based; pick the attempt_no-th one
          const lastAtt = attForChannel[s.attempt - 1] ?? attForChannel[attForChannel.length - 1];

          let stepClass = '';
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
          } else if (isDone && (i + 1) <= attemptNo) {
            stepClass = 'done';
            stateLabel = '✓';
          } else if (isHumanReview && (i + 1) <= attemptNo) {
            stepClass = 'failed';
            stateLabel = '✗';
          }

          const icon = CHANNEL_ICONS[s.channel] ?? '?';
          const baseLabel = CHANNEL_LABELS[s.channel] ?? s.channel;
          const displayLabel = hasRepeats && s.channel !== 'care_everywhere'
            ? `${baseLabel} #${ordinals[s.attempt - 1] ?? s.attempt}`
            : baseLabel;

          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span
                className={`stepper-step ${stepClass}`}
                title={`${displayLabel}${stateLabel ? ' — ' + stateLabel : ''}`}
              >
                <span>{icon}</span>
                <span>{displayLabel}</span>
                {stateLabel && <span>{stateLabel}</span>}
              </span>
              {i < steps.length - 1 && (
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
// Fax paper card (document viewer — for non-workbench views)
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
  const isCEChannel = att.channel === 'care_everywhere';
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
        {isCEChannel && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              padding: '1px 8px',
              borderRadius: '99px',
              fontSize: '0.68rem',
              fontWeight: 700,
              background: '#4f46e5',
              color: '#fff',
            }}
          >
            Structured Exchange
          </span>
        )}
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
            Response
            {isPortalChannel && ' (via portal)'}
            {isCEChannel && ' (C-CDA structured return)'}
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
// Per-field confidence chip
// ---------------------------------------------------------------------------

function FieldConfidenceChip({ meta }: { meta: ExtractionFieldMeta | undefined }) {
  if (!meta) return null;
  const score = meta.confidence;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: '99px',
        fontSize: '0.68rem',
        fontWeight: 700,
        background: confidenceBg(score),
        color: confidenceColor(score),
        border: `1px solid ${confidenceColor(score)}40`,
        marginLeft: '6px',
        flexShrink: 0,
      }}
      title={`Confidence: ${(score * 100).toFixed(0)}% (source line ${meta.sourceLine + 1})`}
    >
      {(score * 100).toFixed(0)}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// Intake workbench — source document with line-by-line highlighting
// ---------------------------------------------------------------------------

function SourceDocumentWithHighlight({
  sourceText,
  extractionMeta,
  hoveredField,
  onLineClick,
  isPhone,
}: {
  sourceText: string;
  extractionMeta: ExtractionMeta | null;
  hoveredField: string | null;
  onLineClick: (lineIdx: number) => void;
  isPhone: boolean;
}) {
  const lines = sourceText.split('\n');

  // Map sourceLine -> field keys that reference it
  const lineToFields: Record<number, string[]> = {};
  if (extractionMeta) {
    for (const [fieldKey, meta] of Object.entries(extractionMeta.fields)) {
      const sl = meta.sourceLine;
      if (!lineToFields[sl]) lineToFields[sl] = [];
      lineToFields[sl].push(fieldKey);
    }
  }

  // Which source line is the hovered field pointing to?
  const highlightedLine = hoveredField && extractionMeta?.fields[hoveredField]
    ? extractionMeta.fields[hoveredField].sourceLine
    : null;

  return (
    <div>
      {/* Paper header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.74rem',
          fontWeight: 700,
          color: isPhone ? 'var(--color-info)' : 'var(--color-ink-muted)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ fontSize: '1rem' }}>{isPhone ? '📞' : '📠'}</span>
        {isPhone ? 'CALL — transcribed' : 'FAX — inbound'}
      </div>

      {/* Line-by-line paper */}
      <div
        className="card-paper wb-source-doc"
        style={{ padding: 0, maxHeight: '520px', overflowY: 'auto', overflowX: 'auto' }}
      >
        {lines.map((line, idx) => {
          const fieldsOnLine = lineToFields[idx] ?? [];
          const hasExtraction = fieldsOnLine.length > 0;
          const isHighlighted = highlightedLine === idx;
          const isClickable = hasExtraction;

          return (
            <div
              key={idx}
              onClick={isClickable ? () => onLineClick(idx) : undefined}
              title={hasExtraction ? `Extracted: ${fieldsOnLine.join(', ')}` : undefined}
              style={{
                padding: '1px 20px',
                cursor: isClickable ? 'pointer' : 'default',
                background: isHighlighted
                  ? 'var(--wb-line-highlight-bg)'
                  : hasExtraction
                  ? 'var(--wb-line-extract-bg)'
                  : 'transparent',
                borderLeft: isHighlighted
                  ? '3px solid var(--wb-line-highlight-border)'
                  : hasExtraction
                  ? '3px solid var(--wb-line-extract-border)'
                  : '3px solid transparent',
                transition: 'background var(--transition), border-color var(--transition)',
                whiteSpace: 'pre',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.82rem',
                lineHeight: 1.65,
                minHeight: '1.65em',
              }}
            >
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable extraction form
// ---------------------------------------------------------------------------

function ExtractionForm({
  extractedData,
  extractionMeta,
  pickedPatientId,
  onHoverField,
  onFlashField,
  flashingField,
  actionInFlight,
  onSubmit,
}: {
  extractedData: Record<string, unknown>;
  extractionMeta: ExtractionMeta | null;
  pickedPatientId: string | null;
  onHoverField: (key: string | null) => void;
  onFlashField: (key: string | null) => void;
  flashingField: string | null;
  actionInFlight: boolean;
  onSubmit: (fields: Record<string, string>, patientId?: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [k, v] of Object.entries(extractedData)) {
      init[k] = String(v ?? '');
    }
    return init;
  });

  // Sync if extractedData prop changes (e.g. on refresh)
  const prevDataRef = useRef(extractedData);
  useEffect(() => {
    if (prevDataRef.current !== extractedData) {
      prevDataRef.current = extractedData;
      const init: Record<string, string> = {};
      for (const [k, v] of Object.entries(extractedData)) {
        init[k] = String(v ?? '');
      }
      setValues(init);
    }
  }, [extractedData]);

  const keys = Object.keys(extractedData);

  if (keys.length === 0) {
    return (
      <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.84rem', fontStyle: 'italic' }}>
        No extracted fields available.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
        {keys.map((k) => {
          const meta = extractionMeta?.fields[k];
          const isFlashing = flashingField === k;

          return (
            <div
              key={k}
              onMouseEnter={() => onHoverField(k)}
              onMouseLeave={() => onHoverField(null)}
              style={{
                background: isFlashing ? 'var(--wb-field-flash-bg)' : 'transparent',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 6px',
                transition: 'background var(--transition)',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.74rem',
                  fontWeight: 700,
                  color: 'var(--color-ink-muted)',
                  textTransform: 'capitalize',
                  marginBottom: '4px',
                  letterSpacing: '0.03em',
                }}
              >
                {k.replace(/_/g, ' ')}
                <FieldConfidenceChip meta={meta} />
              </label>
              <input
                type="text"
                value={values[k] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                style={{
                  ...inputStyle,
                  borderColor: isFlashing ? 'var(--color-accent)' : undefined,
                  boxShadow: isFlashing ? '0 0 0 3px rgba(79,70,229,0.15)' : undefined,
                }}
              />
            </div>
          );
        })}
      </div>

      {pickedPatientId && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--color-success-bg)',
            border: '1px solid #bbf7d0',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.80rem',
            color: 'var(--color-success)',
            fontWeight: 600,
            marginBottom: '12px',
          }}
        >
          Patient selected — will be linked on submit.
        </div>
      )}

      <button
        onClick={() => onSubmit(values, pickedPatientId ?? undefined)}
        disabled={actionInFlight}
        style={{
          ...btnStyle('var(--color-accent)', actionInFlight),
          width: '100%',
          justifyContent: 'center',
          padding: '10px 16px',
          fontSize: '0.88rem',
        }}
      >
        {actionInFlight ? 'Routing…' : 'Confirm & route'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intake review workbench (side-by-side)
// ---------------------------------------------------------------------------

function IntakeWorkbench({
  item,
  patientCandidates,
  agentState,
  extractionMeta,
  actionInFlight,
  actionError,
  actionSuccess,
  onResolveWithPatient,
  onConfirmRoute,
}: {
  item: WorkItemDetail['item'];
  patientCandidates: Patient[];
  agentState: AgentState;
  extractionMeta: ExtractionMeta | null;
  actionInFlight: boolean;
  actionError: string | null;
  actionSuccess: string | null;
  onResolveWithPatient: (patientId: string) => void;
  onConfirmRoute: (fields: Record<string, string>, patientId?: string) => void;
}) {
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const [flashingField, setFlashingField] = useState<string | null>(null);
  const [pickedPatientId, setPickedPatientId] = useState<string | null>(null);

  const sourceText = getSourceText(item);
  const isPhone = item.source_channel === 'phone';
  const extractedData = item.extracted_data ?? {};

  // When a source line is clicked, find the field(s) for that line and flash them
  function handleLineClick(lineIdx: number) {
    if (!extractionMeta) return;
    for (const [fieldKey, meta] of Object.entries(extractionMeta.fields)) {
      if (meta.sourceLine === lineIdx) {
        setFlashingField(fieldKey);
        setTimeout(() => setFlashingField(null), 1200);
        return;
      }
    }
  }

  function handlePickPatient(patientId: string) {
    setPickedPatientId(patientId);
    onResolveWithPatient(patientId);
  }

  return (
    <div>
      {/* Orange review banner — review_reason headline */}
      <div
        style={{
          background: '#fff7ed',
          border: '2px solid #fb923c',
          borderRadius: 'var(--radius)',
          padding: '16px 20px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
        }}
      >
        <span style={{ fontSize: '1.2rem', flexShrink: 0 }}>⚠️</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#9a3412', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>
            Human Review Required
          </div>
          {item.review_reason && (
            <div style={{ fontSize: '0.92rem', color: '#431407', lineHeight: 1.5 }}>
              {item.review_reason}
            </div>
          )}
        </div>
      </div>

      {/* Action feedback */}
      {actionError && (
        <div style={{ background: 'var(--color-error-bg)', border: '1px solid #fca5a5', borderRadius: 'var(--radius-sm)', padding: '8px 14px', color: 'var(--color-error)', fontSize: '0.82rem', marginBottom: '12px' }}>
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div style={{ background: 'var(--color-success-bg)', border: '1px solid #6ee7b7', borderRadius: 'var(--radius-sm)', padding: '8px 14px', color: 'var(--color-success)', fontSize: '0.82rem', marginBottom: '12px' }}>
          {actionSuccess}
        </div>
      )}

      {/* Side-by-side workbench */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* LEFT: source document */}
        <div>
          {sourceText ? (
            <SourceDocumentWithHighlight
              sourceText={sourceText}
              extractionMeta={extractionMeta}
              hoveredField={hoveredField}
              onLineClick={handleLineClick}
              isPhone={isPhone}
            />
          ) : (
            <div className="card" style={{ padding: '32px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: '1.6rem', marginBottom: '8px' }}>📄</div>
              <div style={{ color: 'var(--color-ink-faint)', fontSize: '0.84rem' }}>
                No source document available.
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: patient candidates + editable extraction form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Patient candidates */}
          {patientCandidates.length > 0 && (
            <section>
              <div className="section-label">Patient Candidates</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {patientCandidates.map((p) => (
                  <div
                    key={p.id}
                    className="card"
                    style={{
                      padding: '12px 16px',
                      borderLeft: pickedPatientId === p.id ? '3px solid var(--color-success)' : '3px solid transparent',
                      background: pickedPatientId === p.id ? 'var(--color-success-bg)' : undefined,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{p.first_name} {p.last_name}</div>
                    <div style={{ fontSize: '0.80rem', color: 'var(--color-ink-muted)', marginTop: '2px' }}>
                      DOB: {p.dob} &bull; MRN: {p.mrn}
                    </div>
                    <button
                      onClick={() => handlePickPatient(p.id)}
                      disabled={actionInFlight}
                      style={{ ...btnStyle('var(--color-accent)', actionInFlight), marginTop: '10px' }}
                    >
                      This one
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Editable extraction form */}
          <section className="card">
            <div className="section-label">Extracted Fields — edit to correct</div>
            <ExtractionForm
              extractedData={extractedData as Record<string, unknown>}
              extractionMeta={extractionMeta}
              pickedPatientId={pickedPatientId}
              onHoverField={setHoveredField}
              onFlashField={setFlashingField}
              flashingField={flashingField}
              actionInFlight={actionInFlight}
              onSubmit={onConfirmRoute}
            />
          </section>
        </div>
      </div>
    </div>
  );
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
  // Workbench mode: human_review queue AND not outbound (intake escalations only)
  const isIntakeWorkbench = isHumanReview && !isOutbound;
  const confidence = item.confidence ?? {};
  const agentState = getAgentState(item);
  const sourceText = getSourceText(item);
  const typedAttempts = attempts as AttemptWithDoc[];

  // Extract extraction_meta from agent_state
  const extractionMeta: ExtractionMeta | null =
    agentState.extraction_meta && typeof agentState.extraction_meta === 'object'
      ? (agentState.extraction_meta as ExtractionMeta)
      : null;

  // ---------------------------------------------------------------------------
  // Workbench action handlers
  // ---------------------------------------------------------------------------

  function handleResolveWithPatient(patientId: string) {
    void runAction('resolve_review', { patientId });
  }

  function handleConfirmRoute(fields: Record<string, string>, patientId?: string) {
    const params: Record<string, unknown> = { fields };
    if (patientId) params.patientId = patientId;
    void runAction('resolve_review', params);
  }

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
          {/* Source channel badge */}
          {item.source_channel && (
            <span style={{ fontSize: '0.80rem', display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--color-ink-muted)' }}>
              {CHANNEL_ICONS[item.source_channel] ?? '📬'} {CHANNEL_LABELS[item.source_channel] ?? item.source_channel}
            </span>
          )}
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

      {/* Approval banner — when supervised agent has a pending proposal */}
      {agentState.pending_approval && (
        <ApprovalBanner
          approval={agentState.pending_approval}
          itemId={id}
          onSettled={() => void fetchDetail()}
        />
      )}

      {/* ================================================================
          INTAKE WORKBENCH — human_review + non-outbound
          ================================================================ */}
      {isIntakeWorkbench ? (
        <IntakeWorkbench
          item={item}
          patientCandidates={patientCandidates}
          agentState={agentState}
          extractionMeta={extractionMeta}
          actionInFlight={actionInFlight}
          actionError={actionError}
          actionSuccess={actionSuccess}
          onResolveWithPatient={handleResolveWithPatient}
          onConfirmRoute={handleConfirmRoute}
        />
      ) : (
        /* ================================================================
           STANDARD VIEW — outbound chase or non-review items
           ================================================================ */
        <>
          {/* Human Review block — outbound items that escalated */}
          {isHumanReview && isOutbound && (
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
        </>
      )}

      {/* Manual Actions bar — always available */}
      <section
        className="card"
        style={{ marginTop: '28px', background: '#f8fafc', border: '1px solid var(--color-border-strong)' }}
      >
        <div className="section-label">Manual Actions</div>

        {actionError && !isIntakeWorkbench && (
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
        {actionSuccess && !isIntakeWorkbench && (
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

      {/* Audit timeline — always shown below workbench too */}
      {isIntakeWorkbench && (
        <section className="card" style={{ marginTop: '20px' }}>
          <div className="section-label">Audit Timeline</div>
          <AuditTimeline audit={audit} />
        </section>
      )}
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

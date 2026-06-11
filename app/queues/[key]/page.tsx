'use client';

import { useEffect, useState } from 'react';
import { TimeAgo } from '@/app/components/TimeAgo';
import type { WorkItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutboundChannel = 'fax' | 'email' | 'sms' | 'voice' | 'portal';

interface ChasePlan {
  channels: OutboundChannel[];
  waitSeconds: number;
}

interface AgentState {
  chase_plan?: ChasePlan;
  attempt_no?: number;
  last_channel?: OutboundChannel;
  kind?: string;
}

// WorkItem already includes agent_state; alias with a typed cast helper
type WorkItemWithAgentState = WorkItem;

// ---------------------------------------------------------------------------
// Channel icons + labels
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
  portal: 'Portal',
};

// ---------------------------------------------------------------------------
// Chase Progress component
// ---------------------------------------------------------------------------

function ChaseProgress({ item }: { item: WorkItemWithAgentState }) {
  const agentState = (item.agent_state ?? {}) as AgentState;
  const plan = agentState.chase_plan;

  // Only render for roi_outgoing items that have a chase_plan
  if (!plan || !plan.channels || plan.channels.length === 0) {
    return <span style={{ color: 'var(--color-ink-faint)' }}>—</span>;
  }

  const channels = plan.channels;
  const attemptNo = agentState.attempt_no ?? 0;
  const lastChannel = agentState.last_channel;

  // Derive per-channel state
  // done = all channels tried + item is done
  // human_review = all tried + escalated
  const isDone = item.status === 'done';
  const isHumanReview = item.queue_key === 'human_review';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Icon strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
        {channels.map((ch, i) => {
          const chIdx = i + 1; // 1-based
          let state: 'done' | 'failed' | 'active' | 'pending' = 'pending';

          if (isDone || isHumanReview) {
            // All channels that were tried are marked as failed for human_review, done for done
            if (chIdx <= attemptNo) {
              state = isDone ? 'done' : 'failed';
            }
          } else if (chIdx < attemptNo) {
            state = 'failed'; // previous attempts timed out / failed
          } else if (chIdx === attemptNo || (lastChannel === ch && item.status === 'waiting')) {
            state = 'active';
          }

          let color = 'var(--color-ink-faint)';
          let symbol = '○';
          if (state === 'done')    { color = 'var(--color-success)'; symbol = '✓'; }
          if (state === 'failed')  { color = 'var(--color-error)';   symbol = '✗'; }
          if (state === 'active')  { color = 'var(--color-warning)'; symbol = '●'; }

          return (
            <span
              key={ch}
              title={`${chIdx}. ${CHANNEL_LABELS[ch] ?? ch} — ${state}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '2px',
                fontSize: '0.78rem',
                color,
                fontWeight: state !== 'pending' ? 700 : 400,
              }}
              className={state === 'active' ? 'chase-pulse' : ''}
            >
              <span>{CHANNEL_ICONS[ch] ?? '?'}</span>
              <span style={{ fontSize: '0.68rem' }}>{symbol}</span>
              {i < channels.length - 1 && (
                <span style={{ color: 'var(--color-border-strong)', margin: '0 2px' }}>·</span>
              )}
            </span>
          );
        })}
      </div>

      {/* Attempt counter */}
      {attemptNo > 0 && (
        <div style={{ fontSize: '0.72rem', color: 'var(--color-ink-faint)' }}>
          attempt {attemptNo}/{channels.length}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence meter bar
// ---------------------------------------------------------------------------

function ConfidenceMeter({ confidence }: { confidence: Record<string, number> }) {
  const vals = Object.values(confidence);
  if (vals.length === 0) return <span style={{ color: 'var(--color-ink-faint)' }}>—</span>;
  const score = Math.min(...vals);

  let fillColor = 'var(--color-success)';
  if (score < 0.5) fillColor = 'var(--color-error)';
  else if (score < 0.8) fillColor = 'var(--color-warning)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div className="meter-bar">
        <div
          className="meter-bar-fill"
          style={{ width: `${Math.round(score * 100)}%`, background: fillColor }}
        />
      </div>
      <span style={{ fontSize: '0.74rem', fontWeight: 700, color: fillColor }}>
        {Math.round(score * 100)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open:          'badge-info',
    in_progress:   'badge-warning',
    waiting:       'badge-accent',
    done:          'badge-success',
    error:         'badge-error',
    human_review:  'badge-warning',
  };
  return (
    <span className={`badge ${map[status] ?? 'badge-neutral'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Type badge
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    referral:              'Referral',
    records_request_in:    'ROI In',
    records_request_out:   'ROI Out',
    unknown:               'Unknown',
  };
  return (
    <span className="badge badge-neutral">
      {labels[type] ?? type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Assignee badge
// ---------------------------------------------------------------------------

function AssigneeBadge({ assignee }: { assignee: string }) {
  if (assignee === 'unassigned') {
    return <span style={{ color: 'var(--color-ink-faint)', fontSize: '0.78rem' }}>Unassigned</span>;
  }
  if (assignee === 'human') {
    return <span className="badge badge-success">Human</span>;
  }
  const name = assignee.startsWith('agent:') ? assignee.replace('agent:', '') : assignee;
  return <span className="badge badge-info">{name}</span>;
}

// ---------------------------------------------------------------------------
// Channel source icon
// ---------------------------------------------------------------------------

function ChannelSource({ channel }: { channel: string }) {
  const icon = CHANNEL_ICONS[channel] ?? '📬';
  const label = CHANNEL_LABELS[channel] ?? channel;
  return (
    <span style={{ fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      {icon} {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function QueueDetailPage({ params }: { params: { key: string } }) {
  const queueKey = params.key;
  const [items, setItems] = useState<WorkItemWithAgentState[]>([]);
  const [stale, setStale] = useState(false);

  async function fetchItems() {
    try {
      const res = await fetch(`/api/work-items?queue=${encodeURIComponent(queueKey)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('non-ok');
      const json = (await res.json()) as { data: WorkItemWithAgentState[] } | WorkItemWithAgentState[];
      const data = Array.isArray(json) ? json : (json.data ?? []);
      // API rows are camelCase; render code reads snake_case — add aliases.
      const CAMEL: Array<[string, string]> = [
        ['createdAt', 'created_at'], ['updatedAt', 'updated_at'],
        ['queueKey', 'queue_key'], ['sourceChannel', 'source_channel'],
        ['reviewReason', 'review_reason'], ['agentState', 'agent_state'],
        ['extractedData', 'extracted_data'], ['matchedPatientId', 'matched_patient_id'],
        ['firstName', 'first_name'], ['lastName', 'last_name'],
      ];
      for (const row of data) {
        const o = row as unknown as Record<string, unknown>;
        for (const [c, s] of CAMEL) if (c in o && !(s in o)) o[s] = o[c];
        const p = o['patient'] as Record<string, unknown> | null;
        if (p) for (const [c, s] of CAMEL) if (c in p && !(s in p)) p[s] = p[c];
      }
      setItems(data);
      setStale(false);
    } catch {
      setStale(true);
    }
  }

  useEffect(() => {
    void fetchItems();
    const interval = setInterval(() => void fetchItems(), 4_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  const isOutgoing = queueKey === 'roi_outgoing';
  const isHumanReview = queueKey === 'human_review';

  const queueLabel: Record<string, string> = {
    intake:       'Intake',
    referrals:    'Referrals',
    roi_incoming: 'ROI — Incoming',
    roi_outgoing: 'ROI — Outgoing',
    human_review: 'Human Review',
  };

  return (
    <div>
      {/* Breadcrumb + heading */}
      <div style={{ marginBottom: '20px' }}>
        <a
          href="/queues"
          style={{ fontSize: '0.82rem', color: 'var(--color-accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          ← Queues
        </a>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0, color: 'var(--color-ink)' }}>
            {queueLabel[queueKey] ?? queueKey}
          </h1>
          {isHumanReview && (
            <span className="badge badge-warning" style={{ fontSize: '0.78rem', padding: '4px 12px' }}>
              Needs attention
            </span>
          )}
          {stale && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)', fontWeight: 600 }}>stale</span>
          )}
        </div>
        <p style={{ color: 'var(--color-ink-muted)', margin: '4px 0 0', fontSize: '0.84rem' }}>
          {items.length} item{items.length !== 1 ? 's' : ''} — polling every 4s
        </p>
      </div>

      {/* Empty state */}
      {items.length === 0 ? (
        <div
          className="card"
          style={{ padding: '48px 32px', textAlign: 'center' }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '10px' }}>
            {isHumanReview ? '⚠️' : isOutgoing ? '📤' : '✓'}
          </div>
          <p style={{ color: 'var(--color-ink-muted)', margin: '0 0 6px', fontWeight: 600 }}>
            {isHumanReview
              ? 'No items awaiting review.'
              : isOutgoing
              ? 'No outbound ROI requests in flight.'
              : 'Queue is empty.'}
          </p>
          <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.82rem', margin: 0 }}>
            {isOutgoing
              ? 'Compose a new ROI request from the nav above.'
              : 'Inject a simulated fax from the Queues board.'}
          </p>
          {isOutgoing && (
            <a
              href="/roi/new"
              className="btn btn-primary"
              style={{ display: 'inline-flex', marginTop: '16px', textDecoration: 'none' }}
            >
              New ROI Request
            </a>
          )}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Patient</th>
                <th>Org</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Assignee</th>
                {isOutgoing && <th>Chase Progress</th>}
                {isHumanReview && <th>Review Reason</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => { window.location.href = `/items/${item.id}`; }}
                >
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <TimeAgo iso={item.created_at} />
                  </td>
                  <td>
                    <TypeBadge type={item.type} />
                  </td>
                  <td>
                    <ChannelSource channel={item.source_channel} />
                  </td>
                  <td>
                    {item.patient ? (
                      <span style={{ fontSize: '0.84rem' }}>
                        {item.patient.first_name} {item.patient.last_name}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-ink-faint)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {item.org ? (
                      <span style={{ fontSize: '0.84rem' }}>{item.org.name}</span>
                    ) : (
                      <span style={{ color: 'var(--color-ink-faint)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>
                    <ConfidenceMeter confidence={item.confidence} />
                  </td>
                  <td>
                    <AssigneeBadge assignee={item.assignee} />
                  </td>
                  {isOutgoing && (
                    <td>
                      <ChaseProgress item={item} />
                    </td>
                  )}
                  {isHumanReview && (
                    <td style={{ maxWidth: '260px' }}>
                      {item.review_reason ? (
                        <div
                          className="badge badge-warning"
                          style={{ borderRadius: 'var(--radius-sm)', whiteSpace: 'normal', lineHeight: 1.4, padding: '4px 8px', display: 'block' }}
                        >
                          {item.review_reason}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--color-ink-faint)' }}>—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

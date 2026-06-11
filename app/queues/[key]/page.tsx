'use client';

import { useEffect, useState } from 'react';
import { TimeAgo } from '@/app/components/TimeAgo';
import type { WorkItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function minConfidence(confidence: Record<string, number>): number | null {
  const vals = Object.values(confidence);
  if (vals.length === 0) return null;
  return Math.min(...vals);
}

function ConfidenceBadge({ confidence }: { confidence: Record<string, number> }) {
  const score = minConfidence(confidence);
  if (score === null) return <span style={{ color: '#9ca3af' }}>—</span>;

  let bg = '#d1fae5';
  let fg = '#065f46';
  if (score < 0.5) { bg = '#fee2e2'; fg = '#991b1b'; }
  else if (score < 0.8) { bg = '#fef3c7'; fg = '#92400e'; }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        background: bg,
        color: fg,
        fontSize: '0.75rem',
        fontWeight: 700,
      }}
    >
      {(score * 100).toFixed(0)}%
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    open:        { bg: '#dbeafe', fg: '#1d4ed8' },
    in_progress: { bg: '#fef9c3', fg: '#854d0e' },
    waiting:     { bg: '#e0e7ff', fg: '#3730a3' },
    done:        { bg: '#d1fae5', fg: '#065f46' },
    error:       { bg: '#fee2e2', fg: '#991b1b' },
  };
  const theme = map[status] ?? { bg: '#f3f4f6', fg: '#374151' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        background: theme.bg,
        color: theme.fg,
        fontSize: '0.75rem',
        fontWeight: 700,
        textTransform: 'capitalize',
      }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    referral:              'Referral',
    records_request_in:    'ROI In',
    records_request_out:   'ROI Out',
    unknown:               'Unknown',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        background: '#f3f4f6',
        color: '#374151',
        fontSize: '0.75rem',
        fontWeight: 600,
      }}
    >
      {labels[type] ?? type}
    </span>
  );
}

function ChannelLabel({ channel }: { channel: string }) {
  const icons: Record<string, string> = {
    fax:            '☎',   // telephone
    direct_message: '✉',   // envelope
    portal:         '🌐',  // globe
  };
  const labels: Record<string, string> = {
    fax:            'Fax',
    direct_message: 'DM',
    portal:         'Portal',
  };
  return (
    <span style={{ fontSize: '0.82rem' }}>
      {icons[channel] ?? ''} {labels[channel] ?? channel}
    </span>
  );
}

function AssigneeBadge({ assignee }: { assignee: string }) {
  if (assignee === 'unassigned') {
    return <span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>Unassigned</span>;
  }
  if (assignee === 'human') {
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '1px 7px',
          borderRadius: '4px',
          background: '#d1fae5',
          color: '#065f46',
          fontSize: '0.75rem',
          fontWeight: 700,
        }}
      >
        Human
      </span>
    );
  }
  const name = assignee.startsWith('agent:') ? assignee.replace('agent:', '') : assignee;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: '4px',
        background: '#dbeafe',
        color: '#1e40af',
        fontSize: '0.75rem',
        fontWeight: 700,
      }}
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function QueueDetailPage({ params }: { params: { key: string } }) {
  const queueKey = params.key;
  const [items, setItems] = useState<WorkItem[]>([]);
  const [stale, setStale] = useState(false);

  async function fetchItems() {
    try {
      const res = await fetch(`/api/work-items?queue=${encodeURIComponent(queueKey)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('non-ok');
      const data = (await res.json()) as WorkItem[];
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
      <div style={{ marginBottom: '20px' }}>
        <a href="/queues" style={{ fontSize: '0.82rem', color: '#3b82f6', textDecoration: 'none' }}>
          &larr; Queues
        </a>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginTop: '4px' }}>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>
            {queueLabel[queueKey] ?? queueKey}
          </h1>
          {isHumanReview && (
            <span
              style={{
                padding: '3px 10px',
                background: '#ffedd5',
                color: '#7c2d12',
                borderRadius: '5px',
                fontSize: '0.78rem',
                fontWeight: 700,
              }}
            >
              Needs attention
            </span>
          )}
          {stale && (
            <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600 }}>stale</span>
          )}
        </div>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: '0.85rem' }}>
          {items.length} item{items.length !== 1 ? 's' : ''} — polling every 4s
        </p>
      </div>

      {items.length === 0 ? (
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '40px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '8px' }}>
            {isHumanReview ? '⚠️' : '✓'}
          </div>
          <p style={{ color: '#6b7280', margin: 0 }}>
            {isHumanReview
              ? 'No items awaiting review.'
              : 'Queue is empty.'}
          </p>
          <p style={{ color: '#9ca3af', fontSize: '0.82rem', margin: '6px 0 0' }}>
            Inject a simulated fax from the{' '}
            <a href="/queues" style={{ color: '#3b82f6' }}>
              Queues board
            </a>
            .
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              overflow: 'hidden',
              fontSize: '0.82rem',
            }}
          >
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <th style={thCell}>Created</th>
                <th style={thCell}>Type</th>
                <th style={thCell}>Channel</th>
                <th style={thCell}>Patient</th>
                <th style={thCell}>Org</th>
                <th style={thCell}>Status</th>
                <th style={thCell}>Confidence</th>
                <th style={thCell}>Assignee</th>
                {isHumanReview && <th style={thCell}>Review reason</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  style={{
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onClick={() => {
                    window.location.href = `/items/${item.id}`;
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#f0f9ff';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '';
                  }}
                >
                  <td style={tdCell}>
                    <TimeAgo iso={item.created_at} />
                  </td>
                  <td style={tdCell}>
                    <TypeBadge type={item.type} />
                  </td>
                  <td style={tdCell}>
                    <ChannelLabel channel={item.source_channel} />
                  </td>
                  <td style={tdCell}>
                    {item.patient ? (
                      <span>
                        {item.patient.first_name} {item.patient.last_name}
                      </span>
                    ) : (
                      <span style={{ color: '#9ca3af' }}>—</span>
                    )}
                  </td>
                  <td style={tdCell}>
                    {item.org ? (
                      <span>{item.org.name}</span>
                    ) : (
                      <span style={{ color: '#9ca3af' }}>—</span>
                    )}
                  </td>
                  <td style={tdCell}>
                    <StatusBadge status={item.status} />
                  </td>
                  <td style={tdCell}>
                    <ConfidenceBadge confidence={item.confidence} />
                  </td>
                  <td style={tdCell}>
                    <AssigneeBadge assignee={item.assignee} />
                  </td>
                  {isHumanReview && (
                    <td style={{ ...tdCell, maxWidth: '260px' }}>
                      {item.review_reason ? (
                        <div
                          style={{
                            background: '#ffedd5',
                            color: '#7c2d12',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            lineHeight: 1.4,
                          }}
                        >
                          {item.review_reason}
                        </div>
                      ) : (
                        <span style={{ color: '#9ca3af' }}>—</span>
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

const thCell: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontWeight: 700,
  fontSize: '0.75rem',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

const tdCell: React.CSSProperties = {
  padding: '12px 14px',
  verticalAlign: 'top',
};

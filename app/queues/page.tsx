'use client';

import { useEffect, useRef, useState } from 'react';
import { TimeAgo } from '@/app/components/TimeAgo';
import type { WorkQueue, AuditLogEntry } from '@/lib/types';

// ---------------------------------------------------------------------------
// Queue colour accents
// ---------------------------------------------------------------------------

type QueueTheme = { border: string; badge: string; badgeText: string; countColor: string };

const QUEUE_THEMES: Record<string, QueueTheme> = {
  intake: { border: '#3b82f6', badge: '#dbeafe', badgeText: '#1d4ed8', countColor: '#2563eb' },
  referrals: { border: '#10b981', badge: '#d1fae5', badgeText: '#065f46', countColor: '#059669' },
  roi_incoming: { border: '#8b5cf6', badge: '#ede9fe', badgeText: '#5b21b6', countColor: '#7c3aed' },
  roi_outgoing: { border: '#f59e0b', badge: '#fef3c7', badgeText: '#92400e', countColor: '#d97706' },
  // human_review uses amber/attention styling
  human_review: { border: '#f97316', badge: '#ffedd5', badgeText: '#7c2d12', countColor: '#ea580c' },
};

const DEFAULT_THEME: QueueTheme = {
  border: '#6b7280',
  badge: '#f3f4f6',
  badgeText: '#374151',
  countColor: '#6b7280',
};

function themeFor(key: string): QueueTheme {
  return QUEUE_THEMES[key] ?? DEFAULT_THEME;
}

// ---------------------------------------------------------------------------
// Scenario definitions for the Simulate panel
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ key: string; label: string }> = [
  { key: 'fax_referral_clean', label: 'Fax: Referral (clean)' },
  { key: 'fax_roi_clean', label: 'Fax: ROI request (clean)' },
  { key: 'fax_ambiguous_patient', label: 'Fax: Ambiguous patient match' },
  { key: 'fax_messy', label: 'Fax: Messy / garbled OCR' },
  { key: 'dm_records_request', label: 'DM: Records request' },
  { key: 'fax_roi_missing_auth', label: 'Fax: ROI missing auth' },
];

// ---------------------------------------------------------------------------
// Actor badge rendering
// ---------------------------------------------------------------------------

function ActorBadge({ actor }: { actor: string }) {
  let bg = '#e5e7eb';
  let fg = '#374151';
  let label = actor;

  if (actor.startsWith('agent:')) {
    bg = '#dbeafe';
    fg = '#1e40af';
    label = actor.replace('agent:', '');
  } else if (actor === 'human') {
    bg = '#d1fae5';
    fg = '#065f46';
    label = 'Human';
  } else if (actor === 'system') {
    bg = '#f3f4f6';
    fg = '#6b7280';
    label = 'System';
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: '4px',
        fontSize: '0.72rem',
        fontWeight: 700,
        background: bg,
        color: fg,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toast event list (brief display of tick results)
// ---------------------------------------------------------------------------

interface TickEvent {
  id: string;
  text: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Main board page
// ---------------------------------------------------------------------------

export default function QueuesPage() {
  // Queue board state
  const [queues, setQueues] = useState<WorkQueue[]>([]);
  const [queuesStale, setQueuesStale] = useState(false);

  // Activity feed state
  const [activity, setActivity] = useState<AuditLogEntry[]>([]);
  const [activityStale, setActivityStale] = useState(false);

  // Simulate panel state
  const [simLoading, setSimLoading] = useState<string | null>(null);
  const [tickLoading, setTickLoading] = useState(false);
  const [autoTick, setAutoTick] = useState(false);
  const [tickEvents, setTickEvents] = useState<TickEvent[]>([]);

  const autoTickRef = useRef(false);
  autoTickRef.current = autoTick;

  // ---------------------------------------------------------------------------
  // Polling: queues + activity every 4s
  // ---------------------------------------------------------------------------

  async function fetchQueues() {
    try {
      const res = await fetch('/api/queues', { cache: 'no-store' });
      if (!res.ok) throw new Error('non-ok');
      const data = (await res.json()) as WorkQueue[];
      setQueues(data);
      setQueuesStale(false);
    } catch {
      setQueuesStale(true);
    }
  }

  async function fetchActivity() {
    try {
      const res = await fetch('/api/activity?limit=30', { cache: 'no-store' });
      if (!res.ok) throw new Error('non-ok');
      const data = (await res.json()) as AuditLogEntry[];
      setActivity(data);
      setActivityStale(false);
    } catch {
      setActivityStale(true);
    }
  }

  useEffect(() => {
    void fetchQueues();
    void fetchActivity();
    const interval = setInterval(() => {
      void fetchQueues();
      void fetchActivity();
    }, 4_000);
    return () => clearInterval(interval);
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-tick every 5s when enabled
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!autoTick) return;
    const interval = setInterval(() => {
      if (!autoTickRef.current) return;
      void doTick(true);
    }, 5_000);
    return () => clearInterval(interval);
  }, [autoTick]);

  // ---------------------------------------------------------------------------
  // Simulate handlers
  // ---------------------------------------------------------------------------

  async function injectScenario(scenario: string) {
    setSimLoading(scenario);
    try {
      await fetch('/api/simulate/inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      void fetchQueues();
    } finally {
      setSimLoading(null);
    }
  }

  async function doTick(silent = false) {
    if (!silent) setTickLoading(true);
    try {
      const res = await fetch('/api/simulate/tick', { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as {
          report?: {
            agentRun?: { actions?: Array<{ itemId: string; action: string; actor: string }> };
            respondedAttempts?: string[];
            timedOutAttempts?: string[];
          };
        };
        const actions = body.report?.agentRun?.actions ?? [];
        if (actions.length > 0) {
          const newEvents: TickEvent[] = actions.map((a, i) => ({
            id: `${Date.now()}-${i}`,
            text: `[${a.actor}] ${a.action} on ${a.itemId.slice(0, 8)}`,
            ts: Date.now(),
          }));
          setTickEvents((prev) => [...newEvents, ...prev].slice(0, 20));
        }
        void fetchQueues();
        void fetchActivity();
      }
    } finally {
      if (!silent) setTickLoading(false);
    }
  }

  // Clear stale toast events after 6s
  useEffect(() => {
    if (tickEvents.length === 0) return;
    const t = setTimeout(() => {
      const cutoff = Date.now() - 6_000;
      setTickEvents((prev) => prev.filter((e) => e.ts > cutoff));
    }, 6_000);
    return () => clearTimeout(t);
  }, [tickEvents]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '4px' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>Work Queues</h1>
        {queuesStale && (
          <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600 }}>stale</span>
        )}
      </div>
      <p style={{ color: '#6b7280', marginTop: 0, marginBottom: '28px' }}>
        Live queue board — updates every 4 seconds.
      </p>

      {/* Queue cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '16px',
          marginBottom: '36px',
        }}
      >
        {queues.map((q) => {
          const theme = themeFor(q.key);
          const isHumanReview = q.key === 'human_review';
          return (
            <a
              key={q.key}
              href={`/queues/${q.key}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div
                style={{
                  background: '#fff',
                  border: `1px solid ${theme.border}`,
                  borderLeft: `4px solid ${theme.border}`,
                  borderRadius: '10px',
                  padding: '18px 20px',
                  boxShadow: isHumanReview
                    ? '0 2px 8px rgba(249,115,22,0.15)'
                    : '0 1px 3px rgba(0,0,0,0.06)',
                  cursor: 'pointer',
                  transition: 'box-shadow 0.15s',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '8px',
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1.3 }}>
                    {q.name}
                  </span>
                  <span
                    style={{
                      fontSize: '1.5rem',
                      fontWeight: 800,
                      color: theme.countColor,
                      lineHeight: 1,
                      marginLeft: '8px',
                    }}
                  >
                    {q.item_count ?? 0}
                  </span>
                </div>
                {q.description && (
                  <p style={{ fontSize: '0.78rem', color: '#6b7280', margin: 0, lineHeight: 1.4 }}>
                    {q.description}
                  </p>
                )}
                {isHumanReview && (
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '4px 8px',
                      background: '#ffedd5',
                      borderRadius: '4px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      color: '#7c2d12',
                    }}
                  >
                    Needs attention
                  </div>
                )}
              </div>
            </a>
          );
        })}
        {queues.length === 0 && (
          <p style={{ color: '#9ca3af', gridColumn: '1 / -1' }}>No queues found.</p>
        )}
      </div>

      {/* Two-column: Simulate + Activity */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '24px',
          alignItems: 'start',
        }}
      >
        {/* Simulate panel */}
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          }}
        >
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 4px' }}>Simulate</h2>
          <p style={{ fontSize: '0.78rem', color: '#6b7280', margin: '0 0 16px' }}>
            Inject a scenario or advance the world clock.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                onClick={() => injectScenario(s.key)}
                disabled={simLoading === s.key}
                style={{
                  padding: '8px 12px',
                  background: simLoading === s.key ? '#93c5fd' : '#1e3a5f',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: simLoading === s.key ? 'default' : 'pointer',
                  textAlign: 'left',
                  opacity: simLoading !== null && simLoading !== s.key ? 0.7 : 1,
                }}
              >
                {simLoading === s.key ? 'Injecting…' : `+ ${s.label}`}
              </button>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              paddingTop: '12px',
              borderTop: '1px solid #f3f4f6',
            }}
          >
            <button
              onClick={() => doTick()}
              disabled={tickLoading}
              style={{
                padding: '8px 14px',
                background: tickLoading ? '#d1fae5' : '#059669',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: tickLoading ? 'default' : 'pointer',
              }}
            >
              {tickLoading ? 'Ticking…' : 'Tick now'}
            </button>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <div
                onClick={() => setAutoTick((v) => !v)}
                style={{
                  width: '36px',
                  height: '20px',
                  borderRadius: '10px',
                  background: autoTick ? '#059669' : '#d1d5db',
                  position: 'relative',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: autoTick ? '18px' : '2px',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s',
                  }}
                />
              </div>
              Auto-tick (5s)
            </label>
          </div>

          {/* Toast event list */}
          {tickEvents.length > 0 && (
            <div
              style={{
                marginTop: '12px',
                padding: '10px 12px',
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: '6px',
                maxHeight: '160px',
                overflowY: 'auto',
              }}
            >
              {tickEvents.map((e) => (
                <div
                  key={e.id}
                  style={{ fontSize: '0.75rem', color: '#065f46', lineHeight: 1.6 }}
                >
                  {e.text}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '4px',
            }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Activity Feed</h2>
            {activityStale && (
              <span style={{ fontSize: '0.72rem', color: '#f59e0b', fontWeight: 600 }}>stale</span>
            )}
          </div>
          <p style={{ fontSize: '0.78rem', color: '#6b7280', margin: '0 0 12px' }}>
            Latest 30 audit events — live.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '480px', overflowY: 'auto' }}>
            {activity.map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'flex-start',
                  paddingBottom: '10px',
                  borderBottom: '1px solid #f9fafb',
                }}
              >
                <ActorBadge actor={entry.actor} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{entry.action}</div>
                  {entry.work_item_id && (
                    <a
                      href={`/items/${entry.work_item_id}`}
                      style={{
                        fontSize: '0.72rem',
                        color: '#3b82f6',
                        textDecoration: 'none',
                        display: 'block',
                        marginTop: '1px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.work_item_id}
                    </a>
                  )}
                </div>
                <span style={{ fontSize: '0.72rem', color: '#9ca3af', whiteSpace: 'nowrap' }}>
                  <TimeAgo iso={entry.created_at} />
                </span>
              </div>
            ))}
            {activity.length === 0 && (
              <p style={{ color: '#9ca3af', fontSize: '0.85rem', margin: 0 }}>
                No activity yet — inject a scenario to get started.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

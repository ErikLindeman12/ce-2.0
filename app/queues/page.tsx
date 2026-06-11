'use client';

import { useEffect, useRef, useState } from 'react';
import { TimeAgo } from '@/app/components/TimeAgo';
import type { WorkQueue, AuditLogEntry } from '@/lib/types';

// ---------------------------------------------------------------------------
// Queue colour accents (design-token aligned)
// ---------------------------------------------------------------------------

type QueueTheme = { borderColor: string; badgeClass: string; countColor: string };

const QUEUE_THEMES: Record<string, QueueTheme> = {
  intake:       { borderColor: '#3b82f6', badgeClass: 'badge-info',    countColor: '#2563eb' },
  referrals:    { borderColor: '#10b981', badgeClass: 'badge-success', countColor: '#059669' },
  roi_incoming: { borderColor: '#8b5cf6', badgeClass: 'badge-accent',  countColor: '#7c3aed' },
  roi_outgoing: { borderColor: 'var(--color-warning)', badgeClass: 'badge-warning', countColor: 'var(--color-warning)' },
  human_review: { borderColor: '#f97316', badgeClass: 'badge-warning', countColor: '#ea580c' },
};

const DEFAULT_THEME: QueueTheme = {
  borderColor: 'var(--color-border-strong)',
  badgeClass:  'badge-neutral',
  countColor:  'var(--color-ink-muted)',
};

function themeFor(key: string): QueueTheme {
  return QUEUE_THEMES[key] ?? DEFAULT_THEME;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ key: string; label: string }> = [
  { key: 'fax_referral_clean',    label: 'Fax: Referral (clean)' },
  { key: 'fax_roi_clean',         label: 'Fax: ROI request (clean)' },
  { key: 'fax_ambiguous_patient', label: 'Fax: Ambiguous patient match' },
  { key: 'fax_messy',             label: 'Fax: Messy / garbled OCR' },
  { key: 'dm_records_request',    label: 'DM: Records request' },
  { key: 'fax_roi_missing_auth',  label: 'Fax: ROI missing auth' },
];

// ---------------------------------------------------------------------------
// Actor badge
// ---------------------------------------------------------------------------

function ActorBadge({ actor }: { actor: string }) {
  const isPortal = actor.startsWith('portal:');
  if (isPortal) {
    return (
      <span className="badge badge-portal" style={{ whiteSpace: 'nowrap' }}>
        🌐 {actor.replace('portal:', '')}
      </span>
    );
  }
  if (actor.startsWith('agent:')) {
    return (
      <span className="badge badge-info" style={{ whiteSpace: 'nowrap' }}>
        {actor.replace('agent:', '')}
      </span>
    );
  }
  if (actor === 'human') {
    return <span className="badge badge-success">Human</span>;
  }
  return <span className="badge badge-neutral">{actor}</span>;
}

// ---------------------------------------------------------------------------
// Toast event list
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
  const [queues, setQueues] = useState<WorkQueue[]>([]);
  const [queuesStale, setQueuesStale] = useState(false);
  const [activity, setActivity] = useState<AuditLogEntry[]>([]);
  const [activityStale, setActivityStale] = useState(false);

  const [simLoading, setSimLoading] = useState<string | null>(null);
  const [tickLoading, setTickLoading] = useState(false);
  const [autoTick, setAutoTick] = useState(false);
  const [tickEvents, setTickEvents] = useState<TickEvent[]>([]);

  const autoTickRef = useRef(false);
  autoTickRef.current = autoTick;

  // Polling: queues + activity every 4s
  async function fetchQueues() {
    try {
      const res = await fetch('/api/queues', { cache: 'no-store' });
      if (!res.ok) throw new Error('non-ok');
      setQueues((await res.json()) as WorkQueue[]);
      setQueuesStale(false);
    } catch { setQueuesStale(true); }
  }

  async function fetchActivity() {
    try {
      const res = await fetch('/api/activity?limit=30', { cache: 'no-store' });
      if (!res.ok) throw new Error('non-ok');
      setActivity((await res.json()) as AuditLogEntry[]);
      setActivityStale(false);
    } catch { setActivityStale(true); }
  }

  useEffect(() => {
    void fetchQueues();
    void fetchActivity();
    const interval = setInterval(() => { void fetchQueues(); void fetchActivity(); }, 4_000);
    return () => clearInterval(interval);
  }, []);

  // Auto-tick
  useEffect(() => {
    if (!autoTick) return;
    const interval = setInterval(() => { if (autoTickRef.current) void doTick(true); }, 5_000);
    return () => clearInterval(interval);
  }, [autoTick]);

  async function injectScenario(scenario: string) {
    setSimLoading(scenario);
    try {
      await fetch('/api/simulate/inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      void fetchQueues();
    } finally { setSimLoading(null); }
  }

  async function doTick(silent = false) {
    if (!silent) setTickLoading(true);
    try {
      const res = await fetch('/api/simulate/tick', { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as {
          report?: { agentRun?: { actions?: Array<{ itemId: string; action: string; actor: string }> } };
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
    } finally { if (!silent) setTickLoading(false); }
  }

  // Expire tick events
  useEffect(() => {
    if (tickEvents.length === 0) return;
    const t = setTimeout(() => {
      setTickEvents((prev) => prev.filter((e) => e.ts > Date.now() - 6_000));
    }, 6_000);
    return () => clearTimeout(t);
  }, [tickEvents]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0, color: 'var(--color-ink)' }}>Work Queues</h1>
        {queuesStale && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)', fontWeight: 600 }}>stale</span>
        )}
      </div>
      <p style={{ color: 'var(--color-ink-muted)', marginTop: 0, marginBottom: '28px', fontSize: '0.88rem' }}>
        Live queue board — updates every 4 seconds.
      </p>

      {/* Queue cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '14px',
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
                className="card"
                style={{
                  borderLeft: `4px solid ${theme.borderColor}`,
                  cursor: 'pointer',
                  transition: 'box-shadow var(--transition), transform var(--transition)',
                  boxShadow: isHumanReview ? '0 2px 8px rgba(249,115,22,0.15)' : 'var(--shadow-card)',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md)';
                  (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = isHumanReview
                    ? '0 2px 8px rgba(249,115,22,0.15)'
                    : 'var(--shadow-card)';
                  (e.currentTarget as HTMLDivElement).style.transform = '';
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.90rem', lineHeight: 1.3 }}>
                    {q.name}
                  </span>
                  <span style={{ fontSize: '1.4rem', fontWeight: 800, color: theme.countColor, lineHeight: 1 }}>
                    {q.item_count ?? 0}
                  </span>
                </div>
                {q.description && (
                  <p style={{ fontSize: '0.76rem', color: 'var(--color-ink-muted)', margin: 0, lineHeight: 1.4 }}>
                    {q.description}
                  </p>
                )}
                {isHumanReview && (
                  <div
                    className="badge badge-warning"
                    style={{ marginTop: '10px', borderRadius: 'var(--radius-sm)', display: 'inline-block' }}
                  >
                    Needs attention
                  </div>
                )}
              </div>
            </a>
          );
        })}
        {queues.length === 0 && (
          <p style={{ color: 'var(--color-ink-faint)', gridColumn: '1 / -1' }}>
            No queues found.
          </p>
        )}
      </div>

      {/* Two-column: Simulate + Activity */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* Simulate panel */}
        <div className="card">
          <h2 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 2px', color: 'var(--color-ink)' }}>
            Simulate
          </h2>
          <p style={{ fontSize: '0.78rem', color: 'var(--color-ink-muted)', margin: '0 0 14px' }}>
            Inject a scenario or advance the world clock.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                onClick={() => void injectScenario(s.key)}
                disabled={simLoading === s.key}
                className="btn btn-ghost"
                style={{
                  textAlign: 'left',
                  justifyContent: 'flex-start',
                  fontSize: '0.80rem',
                  opacity: simLoading !== null && simLoading !== s.key ? 0.6 : 1,
                }}
              >
                {simLoading === s.key ? '↻ Injecting…' : `+ ${s.label}`}
              </button>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              paddingTop: '12px',
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <button
              onClick={() => void doTick()}
              disabled={tickLoading}
              className="btn btn-success"
              style={{ fontSize: '0.80rem' }}
            >
              {tickLoading ? 'Ticking…' : 'Tick now'}
            </button>

            {/* Toggle */}
            <label
              style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', fontSize: '0.80rem', fontWeight: 600 }}
              onClick={() => setAutoTick((v) => !v)}
            >
              <div
                style={{
                  width: '34px', height: '19px',
                  borderRadius: '10px',
                  background: autoTick ? 'var(--color-success)' : 'var(--color-border-strong)',
                  position: 'relative',
                  transition: 'background var(--transition)',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: autoTick ? '17px' : '2px',
                    width: '15px', height: '15px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left var(--transition)',
                  }}
                />
              </div>
              Auto-tick (5s)
            </label>
          </div>

          {/* Tick event toast */}
          {tickEvents.length > 0 && (
            <div
              style={{
                marginTop: '12px',
                padding: '10px 12px',
                background: 'var(--color-success-bg)',
                border: '1px solid #bbf7d0',
                borderRadius: 'var(--radius-sm)',
                maxHeight: '140px',
                overflowY: 'auto',
              }}
            >
              {tickEvents.map((e) => (
                <div key={e.id} style={{ fontSize: '0.74rem', color: 'var(--color-success)', lineHeight: 1.7 }}>
                  {e.text}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
            <h2 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: 'var(--color-ink)' }}>
              Activity Feed
            </h2>
            {activityStale && (
              <span style={{ fontSize: '0.72rem', color: 'var(--color-warning)', fontWeight: 600 }}>stale</span>
            )}
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--color-ink-muted)', margin: '0 0 12px' }}>
            Latest 30 audit events — live.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '460px', overflowY: 'auto' }}>
            {activity.map((entry) => {
              const isPortal = entry.actor.startsWith('portal:');
              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'flex-start',
                    paddingBottom: '10px',
                    borderBottom: '1px solid var(--color-bg)',
                  }}
                >
                  <ActorBadge actor={entry.actor} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '0.80rem',
                        fontWeight: 600,
                        color: isPortal ? 'var(--color-portal)' : 'var(--color-ink)',
                      }}
                    >
                      {entry.action}
                    </div>
                    {entry.work_item_id && (
                      <a
                        href={`/items/${entry.work_item_id}`}
                        style={{
                          fontSize: '0.72rem',
                          color: 'var(--color-accent)',
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
                  <span style={{ fontSize: '0.72rem', color: 'var(--color-ink-faint)', whiteSpace: 'nowrap' }}>
                    <TimeAgo iso={entry.created_at} />
                  </span>
                </div>
              );
            })}
            {activity.length === 0 && (
              <p style={{ color: 'var(--color-ink-faint)', fontSize: '0.84rem', margin: 0 }}>
                No activity yet — inject a scenario to get started.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

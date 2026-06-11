'use client';

import { useEffect, useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentMode = 'autonomous' | 'supervised' | 'shadow';

interface AgentStats {
  processed: number;
  actions: number;
  escalations: number;
  proposals: number;
  shadowDecisions: number;
  avgConfidence: number;
  autoRate: number;
}

interface ChasePolicyConfig {
  steps: string[];  // e.g. ['fax', 'fax', 'voice']
  waitSeconds: number;
}

interface AgentConfig {
  chase_policy?: ChasePolicyConfig;
}

interface Agent {
  id: string;
  name: string;
  queueKey?: string;
  queue_key?: string;
  enabled: boolean;
  instructions: string;
  tools: string[];
  confidenceThreshold?: number;
  confidence_threshold?: number;
  model: string;
  mode?: AgentMode;
  config?: AgentConfig;
  createdAt?: string;
  created_at?: string;
}

interface Queue {
  key: string;
  name: string;
  sortOrder?: number;
  sort_order?: number;
  count?: number;
}

// Normalize agent fields (API may return camelCase per spec or snake_case from DB)
function normalizeAgent(a: Record<string, unknown>): Agent {
  return {
    id: a.id as string,
    name: a.name as string,
    queueKey: (a.queueKey ?? a.queue_key) as string,
    queue_key: (a.queue_key ?? a.queueKey) as string,
    enabled: a.enabled as boolean,
    instructions: (a.instructions as string) ?? '',
    tools: (a.tools as string[]) ?? [],
    confidenceThreshold: (a.confidenceThreshold ?? a.confidence_threshold) as number,
    confidence_threshold: (a.confidence_threshold ?? a.confidenceThreshold) as number,
    model: (a.model as string) ?? 'heuristic',
    mode: ((a.mode as AgentMode | undefined) ?? 'autonomous'),
    config: (a.config as AgentConfig | undefined) ?? {},
    createdAt: (a.createdAt ?? a.created_at) as string | undefined,
    created_at: (a.created_at ?? a.createdAt) as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Escalation ladder editor (roi_outgoing agents only)
// ---------------------------------------------------------------------------

const LADDER_CHANNELS: Array<{ value: string; label: string; icon: string }> = [
  { value: 'fax',   label: 'Fax',          icon: '📠' },
  { value: 'email', label: 'Secure Email',  icon: '✉️' },
  { value: 'sms',   label: 'SMS',           icon: '💬' },
  { value: 'voice', label: 'Voice',         icon: '📞' },
];

function ladderReadout(steps: string[], waitSeconds: number): string {
  const icons: Record<string, string> = { fax: '📠', email: '✉️', sms: '💬', voice: '📞' };
  return steps.map((s) => icons[s] ?? s).join(' → ') + ` · ${waitSeconds}s`;
}

function EscalationLadderEditor({
  agentId,
  initialSteps,
  initialWaitSeconds,
  onSaved,
}: {
  agentId: string;
  initialSteps: string[];
  initialWaitSeconds: number;
  onSaved: () => void;
}) {
  const [steps, setSteps] = useState<string[]>(initialSteps.length > 0 ? initialSteps : ['fax', 'fax', 'voice']);
  const [waitSecs, setWaitSecs] = useState(initialWaitSeconds > 0 ? initialWaitSeconds : 30);
  const [addChannel, setAddChannel] = useState('fax');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  function addStep() {
    setSteps((prev) => [...prev, addChannel]);
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveStep(idx: number, dir: -1 | 1) {
    const newSteps = [...steps];
    const target = idx + dir;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[idx], newSteps[target]] = [newSteps[target], newSteps[idx]];
    setSteps(newSteps);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            chase_policy: { steps, waitSeconds: waitSecs },
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setSaveError(body.error ?? 'Failed to save');
      } else {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
        onSaved();
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }

  const icons: Record<string, string> = { fax: '📠', email: '✉️', sms: '💬', voice: '📞' };
  const labels: Record<string, string> = { fax: 'Fax', email: 'Secure Email', sms: 'SMS', voice: 'Voice' };

  return (
    <div
      style={{
        marginTop: '14px',
        padding: '14px 16px',
        background: '#f8f9fc',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-ink-faint)', marginBottom: '10px' }}>
        Escalation Ladder
      </div>

      {/* Step chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {steps.length === 0 && (
          <span style={{ fontSize: '0.80rem', color: 'var(--color-ink-faint)', fontStyle: 'italic' }}>No steps — add one below.</span>
        )}
        {steps.map((ch, i) => (
          <span
            key={i}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              background: '#fff',
              border: '1px solid var(--color-border-strong)',
              borderRadius: '6px',
              fontSize: '0.78rem',
              fontWeight: 600,
            }}
          >
            <span>{icons[ch] ?? ch}</span>
            <span>{labels[ch] ?? ch}</span>
            <button
              onClick={() => moveStep(i, -1)}
              disabled={i === 0}
              title="Move left"
              style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', padding: '0 2px', color: 'var(--color-ink-faint)', opacity: i === 0 ? 0.3 : 1, fontSize: '0.72rem' }}
            >
              ◀
            </button>
            <button
              onClick={() => moveStep(i, 1)}
              disabled={i === steps.length - 1}
              title="Move right"
              style={{ background: 'none', border: 'none', cursor: i === steps.length - 1 ? 'default' : 'pointer', padding: '0 2px', color: 'var(--color-ink-faint)', opacity: i === steps.length - 1 ? 0.3 : 1, fontSize: '0.72rem' }}
            >
              ▶
            </button>
            <button
              onClick={() => removeStep(i)}
              title="Remove step"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--color-error)', fontSize: '0.76rem', fontWeight: 700, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* Add step */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px' }}>
        <select
          value={addChannel}
          onChange={(e) => setAddChannel(e.target.value)}
          style={{ padding: '5px 8px', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', fontSize: '0.80rem', background: '#fff' }}
        >
          {LADDER_CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
          ))}
        </select>
        <button
          onClick={addStep}
          style={{
            padding: '5px 10px',
            background: 'var(--color-accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.78rem',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          + Add step
        </button>
      </div>

      {/* Wait seconds */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-ink-muted)', fontWeight: 600 }}>Wait between steps:</span>
        <input
          type="number"
          min={5}
          max={300}
          value={waitSecs}
          onChange={(e) => setWaitSecs(Number(e.target.value))}
          style={{ width: '64px', padding: '4px 8px', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', fontSize: '0.80rem' }}
        />
        <span style={{ fontSize: '0.78rem', color: 'var(--color-ink-faint)' }}>seconds</span>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={() => void handleSave()}
          disabled={saving || steps.length === 0}
          style={{
            padding: '6px 14px',
            background: saving || steps.length === 0 ? 'var(--color-border)' : 'var(--color-success)',
            color: saving || steps.length === 0 ? 'var(--color-ink-faint)' : '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.78rem',
            fontWeight: 700,
            cursor: saving || steps.length === 0 ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save ladder'}
        </button>
        {saveSuccess && (
          <span style={{ fontSize: '0.78rem', color: 'var(--color-success)', fontWeight: 600 }}>Saved</span>
        )}
        {saveError && (
          <span style={{ fontSize: '0.78rem', color: 'var(--color-error)' }}>{saveError}</span>
        )}
      </div>
    </div>
  );
}

function agentQueueKey(a: Agent): string {
  return (a.queueKey ?? a.queue_key) ?? '';
}

function agentThreshold(a: Agent): number {
  return (a.confidenceThreshold ?? a.confidence_threshold) ?? 0.8;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
  'classify_document',
  'extract_fields',
  'match_patient',
  'verify_requirements',
  'advance_stage',
  'send_fax',
  'send_email',
  'send_sms',
  'place_call',
  'request_more_info',
  'mark_complete',
  'escalate_to_human',
];

const QUEUE_KEYS = ['intake', 'referrals', 'roi_incoming', 'roi_outgoing', 'human_review'];

const MODELS = [
  { value: 'heuristic', label: 'Heuristic (no API key needed)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

// ---------------------------------------------------------------------------
// Blank form state
// ---------------------------------------------------------------------------

interface AgentForm {
  name: string;
  queueKey: string;
  instructions: string;
  tools: string[];
  confidenceThreshold: number;
  model: string;
  enabled: boolean;
  mode: AgentMode;
}

function blankForm(): AgentForm {
  return {
    name: '',
    queueKey: 'intake',
    instructions: '',
    tools: [],
    confidenceThreshold: 0.8,
    model: 'heuristic',
    enabled: true,
    mode: 'autonomous',
  };
}

function agentToForm(a: Agent): AgentForm {
  return {
    name: a.name,
    queueKey: agentQueueKey(a),
    instructions: a.instructions,
    tools: a.tools,
    confidenceThreshold: agentThreshold(a),
    model: a.model,
    enabled: a.enabled,
    mode: a.mode ?? 'autonomous',
  };
}

// ---------------------------------------------------------------------------
// Mode selector config
// ---------------------------------------------------------------------------

const MODE_CONFIG: Record<AgentMode, { label: string; desc: string; color: string; bg: string; border: string }> = {
  shadow: {
    label: 'Shadow',
    desc: 'Logs decisions, never acts',
    color: '#6b7280',
    bg: '#f3f4f6',
    border: '#d1d5db',
  },
  supervised: {
    label: 'Supervised',
    desc: 'Proposes — humans approve',
    color: '#92400e',
    bg: '#fef3c7',
    border: '#fcd34d',
  },
  autonomous: {
    label: 'Autonomous',
    desc: 'Acts above the threshold',
    color: '#065f46',
    bg: '#d1fae5',
    border: '#6ee7b7',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null); // null = new
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<AgentForm>(blankForm());

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Toggle in-flight tracking
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  // Mode patch in-flight tracking
  const [patchingMode, setPatchingMode] = useState<Set<string>>(new Set());

  // Per-agent stats (keyed by agent id; null = loading/error)
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats | null>>({});

  // Which agent's ladder editor is open (by agent id; null = none)
  const [openLadderAgentId, setOpenLadderAgentId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  const load = useCallback(async () => {
    try {
      const [agentsRes, queuesRes] = await Promise.all([
        fetch('/api/agents', { cache: 'no-store' }),
        fetch('/api/queues', { cache: 'no-store' }),
      ]);

      const agentsBody = (await agentsRes.json()) as
        | { data: Record<string, unknown>[] }
        | Record<string, unknown>[];
      const rawAgents = Array.isArray(agentsBody)
        ? agentsBody
        : (agentsBody as { data: Record<string, unknown>[] }).data ?? [];
      setAgents(rawAgents.map(normalizeAgent));

      const queuesBody = (await queuesRes.json()) as
        | { data: Queue[] }
        | Queue[];
      const rawQueues = Array.isArray(queuesBody)
        ? queuesBody
        : (queuesBody as { data: Queue[] }).data ?? [];
      setQueues(rawQueues);

      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch per-agent stats whenever agent list changes
  useEffect(() => {
    if (agents.length === 0) return;
    agents.forEach((agent) => {
      fetch(`/api/agents/${agent.id}/stats`, { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) return; // 404 while backend is building — skip gracefully
          const body = (await res.json()) as { data?: AgentStats } | AgentStats;
          const stats = ('data' in body && body.data) ? body.data : (body as AgentStats);
          setAgentStats((prev) => ({ ...prev, [agent.id]: stats }));
        })
        .catch(() => { /* endpoint not ready yet — hide gracefully */ });
    });
  }, [agents]);

  // ---------------------------------------------------------------------------
  // Patch mode inline
  // ---------------------------------------------------------------------------

  async function patchMode(agent: Agent, mode: AgentMode) {
    const id = agent.id;
    setPatchingMode((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      void load();
    } finally {
      setPatchingMode((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Toggle enabled
  // ---------------------------------------------------------------------------

  async function toggleEnabled(agent: Agent) {
    const id = agent.id;
    setToggling((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !agent.enabled }),
      });
      void load();
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Open form
  // ---------------------------------------------------------------------------

  function openNew() {
    setEditingId(null);
    setForm(blankForm());
    setSaveError(null);
    setSaveSuccess(null);
    setShowForm(true);
  }

  function openEdit(agent: Agent) {
    setEditingId(agent.id);
    setForm(agentToForm(agent));
    setSaveError(null);
    setSaveSuccess(null);
    setShowForm(true);
  }

  // ---------------------------------------------------------------------------
  // Save (create or update)
  // ---------------------------------------------------------------------------

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    const payload = {
      name: form.name.trim(),
      queue_key: form.queueKey,
      instructions: form.instructions,
      tools: form.tools,
      confidence_threshold: form.confidenceThreshold,
      model: form.model,
      enabled: form.enabled,
      mode: form.mode,
    };

    try {
      const url = editingId ? `/api/agents/${editingId}` : '/api/agents';
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setSaveError(body.error ?? 'Failed to save agent');
      } else {
        setSaveSuccess(editingId ? 'Agent updated' : 'Agent created');
        setShowForm(false);
        void load();
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool checkbox toggle
  // ---------------------------------------------------------------------------

  function toggleTool(tool: string) {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool)
        ? prev.tools.filter((t) => t !== tool)
        : [...prev.tools, tool],
    }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return <div style={{ padding: '48px 0', color: '#9ca3af', textAlign: 'center' }}>Loading agents…</div>;
  }

  if (loadError) {
    return <div style={{ padding: '48px 0', color: '#dc2626', textAlign: 'center' }}>{loadError}</div>;
  }

  const queueName = (key: string) =>
    queues.find((q) => q.key === key)?.name ?? key;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 4px' }}>Agent Configuration</h1>
          <p style={{ color: '#6b7280', margin: 0 }}>
            Configure AI agents that process work queue items automatically.
          </p>
        </div>
        <button
          onClick={openNew}
          style={{
            padding: '10px 20px',
            background: '#1e3a5f',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          + New Agent
        </button>
      </div>

      {/* Global save success */}
      {saveSuccess && !showForm && (
        <div style={{
          background: '#d1fae5',
          border: '1px solid #6ee7b7',
          borderRadius: '8px',
          padding: '10px 16px',
          color: '#065f46',
          fontSize: '0.85rem',
          marginBottom: '16px',
        }}>
          {saveSuccess}
        </div>
      )}

      {/* Agent cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '32px' }}>
        {agents.length === 0 && (
          <div style={{ color: '#9ca3af', textAlign: 'center', padding: '32px 0' }}>
            No agents configured. Create one above.
          </div>
        )}
        {agents.map((agent) => {
          const threshold = agentThreshold(agent);
          const queueKey = agentQueueKey(agent);
          const currentMode: AgentMode = agent.mode ?? 'autonomous';
          const modePatching = patchingMode.has(agent.id);
          const stats = agentStats[agent.id] ?? null;
          const isRoiOutgoing = queueKey === 'roi_outgoing';
          const chasePolicy = agent.config?.chase_policy;
          const showLadderEditor = openLadderAgentId === agent.id;

          return (
            <div key={agent.id} style={{
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '10px',
              padding: '18px 20px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div style={{ flex: 1 }}>
                  {/* Name row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem' }}>{agent.name}</span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '99px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      background: '#ede9fe',
                      color: '#6d28d9',
                    }}>
                      {queueName(queueKey)}
                    </span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '99px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      background: '#f3f4f6',
                      color: '#374151',
                    }}>
                      {agent.model}
                    </span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '99px',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      background: '#fef3c7',
                      color: '#92400e',
                    }}>
                      threshold: {(threshold * 100).toFixed(0)}%
                    </span>
                  </div>

                  {/* Mode selector */}
                  <div style={{ marginBottom: '10px' }}>
                    <div className="agent-mode-selector" style={{ opacity: modePatching ? 0.6 : 1, pointerEvents: modePatching ? 'none' : 'auto' }}>
                      {(Object.keys(MODE_CONFIG) as AgentMode[]).map((m) => {
                        const cfg = MODE_CONFIG[m];
                        const active = currentMode === m;
                        return (
                          <button
                            key={m}
                            onClick={() => void patchMode(agent, m)}
                            className={`agent-mode-btn${active ? ' active' : ''}`}
                            style={active ? {
                              background: cfg.bg,
                              color: cfg.color,
                              borderColor: cfg.border,
                            } : {}}
                            title={cfg.desc}
                          >
                            <span className="agent-mode-label">{cfg.label}</span>
                            <span className="agent-mode-desc">{cfg.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mini stats strip */}
                  {stats !== null ? (
                    <div className="agent-mini-stats">
                      <span className="agent-mini-stat">
                        <span className="agent-mini-stat-label">Processed</span>
                        <span className="agent-mini-stat-value">{stats.processed}</span>
                      </span>
                      <span className="agent-mini-stat-divider" />
                      <span className="agent-mini-stat">
                        <span className="agent-mini-stat-label">Auto-rate</span>
                        <span className="agent-mini-stat-value">{(stats.autoRate * 100).toFixed(0)}%</span>
                      </span>
                      <span className="agent-mini-stat-divider" />
                      <span className="agent-mini-stat">
                        <span className="agent-mini-stat-label">Escalations</span>
                        <span className="agent-mini-stat-value">{stats.escalations}</span>
                      </span>
                      <span className="agent-mini-stat-divider" />
                      <span className="agent-mini-stat">
                        <span className="agent-mini-stat-label">Proposals</span>
                        <span className="agent-mini-stat-value">{stats.proposals}</span>
                      </span>
                    </div>
                  ) : (
                    /* Skeleton shown while loading; hides if 404 */
                    <div className="agent-mini-stats agent-mini-stats-skeleton" aria-hidden="true">
                      {[80, 52, 72, 60].map((w, i) => (
                        <span key={i} className="agent-mini-stat-skel" style={{ width: w }} />
                      ))}
                    </div>
                  )}

                  {/* Tool chips */}
                  {agent.tools.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px', marginTop: '10px' }}>
                      {agent.tools.map((t) => (
                        <span key={t} style={{
                          padding: '2px 8px',
                          background: '#dbeafe',
                          color: '#1e40af',
                          borderRadius: '99px',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                        }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Escalation ladder readout + editor — roi_outgoing agents only */}
                  {isRoiOutgoing && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--color-ink-muted)' }}>
                          Ladder:
                        </span>
                        {chasePolicy?.steps?.length ? (
                          <code style={{ fontSize: '0.75rem', background: '#f1f3f6', padding: '2px 7px', borderRadius: '4px', color: 'var(--color-ink)' }}>
                            {ladderReadout(chasePolicy.steps, chasePolicy.waitSeconds)}
                          </code>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--color-ink-faint)', fontStyle: 'italic' }}>
                            default (📠 → 📠 → 📞 · 30s)
                          </span>
                        )}
                        <button
                          onClick={() => setOpenLadderAgentId(showLadderEditor ? null : agent.id)}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.74rem',
                            fontWeight: 600,
                            color: 'var(--color-accent)',
                            padding: '0',
                            textDecoration: 'underline',
                            textUnderlineOffset: '2px',
                          }}
                        >
                          {showLadderEditor ? 'Close editor' : 'Edit ladder'}
                        </button>
                      </div>
                      {showLadderEditor && (
                        <EscalationLadderEditor
                          agentId={agent.id}
                          initialSteps={chasePolicy?.steps ?? []}
                          initialWaitSeconds={chasePolicy?.waitSeconds ?? 30}
                          onSaved={() => { void load(); setOpenLadderAgentId(null); }}
                        />
                      )}
                    </div>
                  )}

                  {agent.instructions && (
                    <div style={{ fontSize: '0.78rem', color: '#6b7280', fontStyle: 'italic', marginTop: '8px' }}>
                      {agent.instructions.length > 120
                        ? agent.instructions.slice(0, 120) + '…'
                        : agent.instructions}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                  {/* Enabled toggle */}
                  <button
                    onClick={() => void toggleEnabled(agent)}
                    disabled={toggling.has(agent.id)}
                    title={agent.enabled ? 'Disable agent' : 'Enable agent'}
                    style={{
                      padding: '6px 14px',
                      background: agent.enabled ? '#d1fae5' : '#fee2e2',
                      color: agent.enabled ? '#065f46' : '#991b1b',
                      border: `1px solid ${agent.enabled ? '#6ee7b7' : '#fca5a5'}`,
                      borderRadius: '99px',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      cursor: toggling.has(agent.id) ? 'default' : 'pointer',
                    }}
                  >
                    {toggling.has(agent.id) ? '…' : agent.enabled ? 'Enabled' : 'Disabled'}
                  </button>

                  <button
                    onClick={() => openEdit(agent)}
                    style={{
                      padding: '6px 14px',
                      background: '#f3f4f6',
                      color: '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div style={{
          background: '#fff',
          border: '1px solid #c7d2fe',
          borderRadius: '12px',
          padding: '24px 28px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 800, margin: 0 }}>
              {editingId ? 'Edit Agent' : 'New Agent'}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '1.2rem' }}
            >
              &times;
            </button>
          </div>

          <form onSubmit={(e) => void handleSave(e)} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

            {/* Name */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Intake Agent"
                required
                style={inputStyle}
              />
            </div>

            {/* Queue select */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Queue</label>
              <select
                value={form.queueKey}
                onChange={(e) => setForm((f) => ({ ...f, queueKey: e.target.value }))}
                style={selectStyle}
              >
                {(queues.length > 0 ? queues.map((q) => q.key) : QUEUE_KEYS).map((key) => (
                  <option key={key} value={key}>
                    {queues.find((q) => q.key === key)?.name ?? key}
                  </option>
                ))}
              </select>
            </div>

            {/* Instructions */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Instructions</label>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                placeholder="Custom instructions for this agent's behavior…"
                rows={4}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>

            {/* Tool checkboxes */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Allowed Tools</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {ALL_TOOLS.map((tool) => (
                  <label key={tool} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    background: form.tools.includes(tool) ? '#dbeafe' : '#f9fafb',
                    border: `1px solid ${form.tools.includes(tool) ? '#93c5fd' : '#e5e7eb'}`,
                    borderRadius: '99px',
                    cursor: 'pointer',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    color: form.tools.includes(tool) ? '#1e40af' : '#6b7280',
                    userSelect: 'none',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.tools.includes(tool)}
                      onChange={() => toggleTool(tool)}
                      style={{ display: 'none' }}
                    />
                    {form.tools.includes(tool) ? '✓ ' : ''}{tool}
                  </label>
                ))}
              </div>
            </div>

            {/* Confidence threshold slider */}
            <div style={fieldGroup}>
              <label style={labelStyle}>
                Confidence Threshold — <strong>{(form.confidenceThreshold * 100).toFixed(0)}%</strong>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={form.confidenceThreshold}
                onChange={(e) => setForm((f) => ({ ...f, confidenceThreshold: parseFloat(e.target.value) }))}
                style={{ width: '100%', accentColor: '#4f46e5' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#9ca3af' }}>
                <span>0% (always runs)</span>
                <span>100% (always escalates)</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '2px' }}>
                Below this threshold → escalates to Human Review
              </div>
            </div>

            {/* Model select */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Model</label>
              <select
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                style={selectStyle}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* Mode */}
            <div style={fieldGroup}>
              <label style={labelStyle}>Mode</label>
              <div className="agent-mode-selector">
                {(Object.keys(MODE_CONFIG) as AgentMode[]).map((m) => {
                  const cfg = MODE_CONFIG[m];
                  const active = form.mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, mode: m }))}
                      className={`agent-mode-btn${active ? ' active' : ''}`}
                      style={active ? {
                        background: cfg.bg,
                        color: cfg.color,
                        borderColor: cfg.border,
                      } : {}}
                    >
                      <span className="agent-mode-label">{cfg.label}</span>
                      <span className="agent-mode-desc">{cfg.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Enabled */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="checkbox"
                id="agent-enabled"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                style={{ width: '16px', height: '16px', accentColor: '#4f46e5', cursor: 'pointer' }}
              />
              <label htmlFor="agent-enabled" style={{ fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}>
                Enabled (agent will pick up items on next tick)
              </label>
            </div>

            {/* Errors */}
            {saveError && (
              <div style={{
                background: '#fee2e2',
                border: '1px solid #fca5a5',
                borderRadius: '8px',
                padding: '10px 16px',
                color: '#991b1b',
                fontSize: '0.82rem',
              }}>
                {saveError}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="submit"
                disabled={saving || !form.name.trim()}
                style={{
                  padding: '10px 24px',
                  background: saving || !form.name.trim() ? '#d1d5db' : '#4f46e5',
                  color: saving || !form.name.trim() ? '#9ca3af' : '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  cursor: saving || !form.name.trim() ? 'default' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Agent'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                style={{
                  padding: '10px 20px',
                  background: 'none',
                  color: '#6b7280',
                  border: '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const fieldGroup: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.82rem',
  fontWeight: 700,
  color: '#374151',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  width: '100%',
};

const selectStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '0.9rem',
  background: '#fff',
  width: '100%',
  fontFamily: 'inherit',
};

/**
 * lib/agentRunner.ts — the supervision loop.
 *
 * runAgents(): Promise<RunReport>
 *   For each enabled agent → fetch up to 5 eligible items → step through
 *   the pipeline (max 4 tool calls per run) → write audit_log.
 *
 * Concurrency safety: uses an optimistic UPDATE ... WHERE assignee='unassigned'
 * (or 'waiting') to claim items — two concurrent ticks cannot double-process
 * the same item.
 */

import { getSupabase } from './supabase';
import { reason } from './llm';
import { runTool } from './tools';
import type { Agent, RunReport, WorkItem } from './types';

const MAX_TOOLS_PER_RUN = 4;
const MAX_ITEMS_PER_AGENT = 5;

// ---------------------------------------------------------------------------
// Claim an item for an agent (optimistic — returns false if already claimed)
// ---------------------------------------------------------------------------

async function claimItem(itemId: string, agentId: string): Promise<boolean> {
  const actor = `agent:${agentId}`;

  // Claim open items
  const { data: openClaimed, error: openErr } = await getSupabase()
    .from('work_items')
    .update({ assignee: actor, status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .eq('assignee', 'unassigned')
    .eq('status', 'open')
    .select('id');

  if (!openErr && openClaimed && openClaimed.length > 0) return true;

  // Claim waiting items that are ready to resume
  const { data: waitClaimed } = await getSupabase()
    .from('work_items')
    .update({ assignee: actor, status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .eq('assignee', 'unassigned')
    .eq('status', 'waiting')
    .select('id');

  return !!(waitClaimed && waitClaimed.length > 0);
}

// ---------------------------------------------------------------------------
// Release an item claim (set back to open/waiting for next tick if not done)
// ---------------------------------------------------------------------------

async function releaseItem(itemId: string): Promise<void> {
  // If still in_progress after our run, set back to open so next tick picks it up
  await getSupabase()
    .from('work_items')
    .update({ assignee: 'unassigned', status: 'open', updated_at: new Date().toISOString() })
    .eq('id', itemId)
    .eq('status', 'in_progress');
}

// ---------------------------------------------------------------------------
// Fetch eligible items for an agent's queue
// ---------------------------------------------------------------------------

async function fetchEligibleItems(agent: Agent): Promise<WorkItem[]> {
  const sb = getSupabase();

  // Fetch open items in the queue that aren't assigned to a human
  const { data, error } = await sb
    .from('work_items')
    .select('*')
    .eq('queue_key', agent.queue_key)
    .in('status', ['open', 'waiting'])
    .eq('assignee', 'unassigned')
    .neq('queue_key', 'human_review')
    .order('created_at', { ascending: true })
    .limit(MAX_ITEMS_PER_AGENT);

  if (error) {
    console.log('[agent.run.fetch_error]', JSON.stringify({ agentId: agent.id, error: error.message }));
    return [];
  }

  return (data ?? []) as unknown as WorkItem[];
}

// ---------------------------------------------------------------------------
// Step a single item through the agent pipeline
// ---------------------------------------------------------------------------

async function stepItem(
  item: WorkItem,
  agent: Agent,
  actor: string,
): Promise<Array<{ itemId: string; action: string; confidence: number; actor: string }>> {
  const actions: Array<{ itemId: string; action: string; confidence: number; actor: string }> = [];
  const stepHistory: string[] = [];

  // Re-fetch the item to get latest state before each step
  let currentItem = item;

  for (let step = 0; step < MAX_TOOLS_PER_RUN; step++) {
    // Re-fetch latest item state
    const { data: fresh } = await getSupabase()
      .from('work_items')
      .select('*')
      .eq('id', currentItem.id)
      .single();

    if (!fresh) break;
    currentItem = fresh as unknown as WorkItem;

    // Stop if the item moved out of our queue, finished, or went to a human.
    // (A 'waiting' status alone does NOT stop the run — e.g. roi_incoming
    // sends records then must still mark_complete; pipelines with nothing
    // left to do return the 'wait' no-op decision instead.)
    if (
      currentItem.queue_key !== agent.queue_key ||
      currentItem.status === 'done' ||
      currentItem.assignee === 'human'
    ) {
      break;
    }

    const decision = await reason({
      workItem: currentItem,
      agent,
      stepHistory,
    });

    // Explicit no-op: nothing actionable on this item right now.
    if (decision.action === 'wait') {
      break;
    }

    console.log(
      '[agent.run]',
      JSON.stringify({
        agentId: agent.id,
        agentName: agent.name,
        itemId: currentItem.id,
        step,
        action: decision.action,
        confidence: decision.confidence,
        rationale: decision.rationale,
      }),
    );

    // Confidence gate
    if (decision.confidence < agent.confidence_threshold) {
      // Escalate to human with the specific question (all modes)
      const question =
        decision.question ??
        `Confidence ${decision.confidence.toFixed(2)} below threshold ${agent.confidence_threshold} on step "${decision.action}". ${decision.rationale}`;

      await runTool(
        'escalate_to_human',
        currentItem.id,
        { question },
        actor,
      );

      actions.push({
        itemId: currentItem.id,
        action: 'escalate_to_human',
        confidence: decision.confidence,
        actor,
      });
      break;
    }

    // Only run tools the agent is allowed to use
    if (!agent.tools.includes(decision.action)) {
      console.log(
        '[agent.run.tool_not_allowed]',
        JSON.stringify({ agentName: agent.name, tool: decision.action }),
      );
      break;
    }

    const agentMode = agent.mode ?? 'autonomous';

    // ----- SHADOW mode: audit the decision, mark it seen, leave item alone -----
    if (agentMode === 'shadow') {
      // Build a step key to avoid re-logging the same decision every tick
      const stepKey = `${decision.action}:${JSON.stringify(decision.params)}`;
      const shadowSeen = ((currentItem.agent_state as Record<string, unknown>)['shadow_seen'] ?? {}) as Record<string, boolean>;

      if (!shadowSeen[stepKey]) {
        const sb = getSupabase();
        await sb.from('audit_log').insert({
          work_item_id: currentItem.id,
          actor,
          action: 'shadow_decision',
          detail: {
            action: decision.action,
            params: decision.params,
            confidence: decision.confidence,
            rationale: decision.rationale,
          },
        });
        const { data: freshData } = await sb
          .from('work_items')
          .select('agent_state')
          .eq('id', currentItem.id)
          .single();
        const freshState = (freshData as { agent_state: Record<string, unknown> } | null)?.agent_state ?? {};
        const updatedSeen = { ...(freshState['shadow_seen'] as Record<string, boolean> ?? {}), [stepKey]: true };
        await sb
          .from('work_items')
          .update({ agent_state: { ...freshState, shadow_seen: updatedSeen }, updated_at: new Date().toISOString() })
          .eq('id', currentItem.id);

        actions.push({ itemId: currentItem.id, action: 'shadow_decision', confidence: decision.confidence, actor });
      }

      // Release item (back to open/unassigned) so other agents/humans can act on it
      await getSupabase()
        .from('work_items')
        .update({ assignee: 'unassigned', status: 'open', updated_at: new Date().toISOString() })
        .eq('id', currentItem.id)
        .eq('status', 'in_progress');
      break;
    }

    // Supervision gates actions with EXTERNAL effects (sends, calls, routing).
    // Annotation steps that only enrich the item (classify/extract/match/
    // verify/complete) execute even under supervision — otherwise one item
    // needs three approvals and the mode is unusable.
    const SUPERVISED_PASSTHROUGH = new Set([
      'classify_document',
      'extract_fields',
      'match_patient',
      'verify_requirements',
      'mark_complete',
    ]);

    // ----- SUPERVISED mode: propose the action, wait for human approval -----
    if (agentMode === 'supervised' && !SUPERVISED_PASSTHROUGH.has(decision.action)) {
      const pendingApproval = {
        action: decision.action,
        params: decision.params,
        confidence: decision.confidence,
        rationale: decision.rationale,
        agentId: agent.id,
        agentName: agent.name,
      };

      const sb = getSupabase();

      // Get current agent_state to preserve it and set return_queue
      const { data: freshItem } = await sb
        .from('work_items')
        .select('agent_state,queue_key')
        .eq('id', currentItem.id)
        .single();
      const currentState = (freshItem as { agent_state: Record<string, unknown>; queue_key: string } | null)?.agent_state ?? {};
      const currentQueue = (freshItem as { agent_state: Record<string, unknown>; queue_key: string } | null)?.queue_key ?? agent.queue_key;

      await sb
        .from('work_items')
        .update({
          agent_state: { ...currentState, pending_approval: pendingApproval, return_queue: currentQueue },
          assignee: 'human',
          queue_key: 'human_review',
          review_reason: `Agent proposes: ${decision.action} (confidence ${decision.confidence.toFixed(2)}) — approve?`,
          status: 'open',
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentItem.id);

      await sb.from('audit_log').insert({
        work_item_id: currentItem.id,
        actor,
        action: 'propose_action',
        detail: {
          action: decision.action,
          params: decision.params,
          confidence: decision.confidence,
          rationale: decision.rationale,
        },
      });

      actions.push({ itemId: currentItem.id, action: 'propose_action', confidence: decision.confidence, actor });
      break;
    }

    // ----- AUTONOMOUS mode: execute (default) -----

    // Add confidence to params for tools that store it
    const toolParams = { ...decision.params, confidence: decision.confidence };

    const result = await runTool(decision.action, currentItem.id, toolParams, actor);

    actions.push({
      itemId: currentItem.id,
      action: decision.action,
      confidence: decision.confidence,
      actor,
    });

    stepHistory.push(decision.action);

    // If we escalated or completed, stop stepping
    if (
      decision.action === 'escalate_to_human' ||
      decision.action === 'mark_complete'
    ) {
      break;
    }

    if (!result.success) {
      console.log(
        '[agent.run.tool_error]',
        JSON.stringify({ action: decision.action, error: result.error }),
      );
      break;
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAgents(): Promise<RunReport> {
  const sb = getSupabase();

  const { data: agentsData, error: agentsErr } = await sb
    .from('agents')
    .select('*')
    .eq('enabled', true);

  if (agentsErr || !agentsData) {
    console.log('[agent.run.load_error]', agentsErr?.message);
    return { processed: 0, actions: [] };
  }

  const agents = agentsData as unknown as Agent[];
  const report: RunReport = { processed: 0, actions: [] };

  for (const agent of agents) {
    const actor = `agent:${agent.id}`;
    const items = await fetchEligibleItems(agent);

    for (const item of items) {
      const claimed = await claimItem(item.id, agent.id);
      if (!claimed) continue; // Another tick claimed it

      try {
        const actions = await stepItem(item, agent, actor);
        report.actions.push(...actions);
        report.processed++;
      } finally {
        // Release claim if item is still in_progress (not done or escalated)
        await releaseItem(item.id);
      }
    }
  }

  return report;
}

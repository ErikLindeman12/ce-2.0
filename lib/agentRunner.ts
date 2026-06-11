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
      // Escalate to human with the specific question
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

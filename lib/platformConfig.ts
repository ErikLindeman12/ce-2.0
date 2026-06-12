/**
 * lib/platformConfig.ts — thin supabase wrappers over the platform-config
 * tables (event_types, routing_rules) plus the agent-config helpers the API
 * layer needs: subscription-based agent resolution, shadow-delivery replay,
 * and builder-payload validation for subscriptions.
 *
 * Workflow knowledge lives in these tables — this module only reads/writes
 * them; it never touches queue placement or case state.
 */

import { getSupabase } from './supabase';
import type { Agent, AgentSubscription, RoutingRule } from './types';

// ---------------------------------------------------------------------------
// event_types
// ---------------------------------------------------------------------------

export interface EventTypeRow {
  type: string;
  description: string | null;
  hidden: boolean;
  created_at: string;
}

/** Visible event types for builder dropdowns (hidden=false, ordered by type). */
export async function listEventTypes(): Promise<EventTypeRow[]> {
  const { data, error } = await getSupabase()
    .from('event_types')
    .select('*')
    .eq('hidden', false)
    .order('type', { ascending: true });
  if (error) throw new Error(`event_types list failed: ${error.message}`);
  return (data ?? []) as EventTypeRow[];
}

// ---------------------------------------------------------------------------
// routing_rules
// ---------------------------------------------------------------------------

export async function listRoutingRules(): Promise<RoutingRule[]> {
  const { data, error } = await getSupabase()
    .from('routing_rules')
    .select('*')
    .order('event_type', { ascending: true })
    .order('priority', { ascending: true });
  if (error) throw new Error(`routing_rules list failed: ${error.message}`);
  return (data ?? []) as RoutingRule[];
}

export interface CreateRoutingRuleInput {
  event_type: string;
  filter?: Record<string, unknown>;
  queue_key: string;
  priority?: number;
  owner?: string;
}

export async function createRoutingRule(input: CreateRoutingRuleInput): Promise<RoutingRule> {
  const { data, error } = await getSupabase()
    .from('routing_rules')
    .insert({
      event_type: input.event_type,
      filter: input.filter ?? {},
      queue_key: input.queue_key,
      priority: input.priority ?? 100,
      owner: input.owner ?? null,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`routing_rule create failed: ${error?.message ?? 'no row returned'}`);
  }
  const rule = data as RoutingRule;
  console.log(
    '[platformConfig.rule_created]',
    JSON.stringify({ ruleId: rule.id, eventType: rule.event_type, queue: rule.queue_key, priority: rule.priority }),
  );
  return rule;
}

// ---------------------------------------------------------------------------
// Shadow replay (agents PATCH: mode flip shadow → supervised|autonomous)
// ---------------------------------------------------------------------------

/**
 * Re-pend an agent's shadowed deliveries so the dispatcher runs them for real.
 * Returns the number of deliveries replayed.
 */
export async function replayShadowedDeliveries(agentId: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from('event_deliveries')
    .update({ status: 'pending', claimed_at: null })
    .eq('agent_id', agentId)
    .eq('status', 'shadowed')
    .select('id');
  if (error) {
    console.log('[platformConfig.replay_failed]', JSON.stringify({ agentId, error: error.message }));
    return 0;
  }
  const count = data?.length ?? 0;
  console.log('[platformConfig.replay_shadowed]', JSON.stringify({ agentId, replayed: count }));
  return count;
}

// ---------------------------------------------------------------------------
// Agent resolution by subscription (replaces by-name lookups)
// ---------------------------------------------------------------------------

/**
 * First enabled agent whose subscriptions contain `event_type` with
 * `filter.case_type === caseType`. Plain JS over the agents rows — null-safe:
 * returns null when no agent matches (callers plan from org/defaults only).
 */
export async function findAgentSubscribedTo(
  eventType: string,
  caseType: string,
): Promise<Agent | null> {
  const { data, error } = await getSupabase().from('agents').select('*').eq('enabled', true);
  if (error) {
    console.log('[platformConfig.agent_lookup_failed]', JSON.stringify({ eventType, caseType, error: error.message }));
    return null;
  }
  const agents = (data ?? []) as Agent[];
  return (
    agents.find((agent) =>
      (agent.subscriptions ?? []).some(
        (sub) => sub?.event_type === eventType && (sub.filter ?? {})['case_type'] === caseType,
      ),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Subscriptions payload validation (agents POST/PATCH whitelist)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a builder-supplied subscriptions payload:
 * array of { event_type: string, filter?: object, on_event?: object }.
 * Returns the typed array, or null when invalid.
 */
export function parseSubscriptions(value: unknown): AgentSubscription[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    if (typeof item['event_type'] !== 'string' || item['event_type'].length === 0) return null;
    if (item['filter'] !== undefined && !isPlainObject(item['filter'])) return null;
    if (item['on_event'] !== undefined && !isPlainObject(item['on_event'])) return null;
  }
  return value as AgentSubscription[];
}

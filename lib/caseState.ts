import { getSupabase } from './supabase';
import type { WorkItem } from './types';

export interface CaseStateMerge {
  /** Keys merged into agent_state (shallow). */
  set?: Record<string, unknown>;
  /** Keys removed from agent_state. */
  clear?: string[];
  /** Keys merged into extracted_data (shallow). */
  mergeExtracted?: Record<string, unknown>;
}

export interface CaseStateResult {
  ok: boolean;
  version: number;
  conflict?: boolean;
}

/**
 * The ONLY sanctioned way to write durable per-case state (work_items.agent_state
 * + extracted_data). Every write bumps state_version; pass `expectedVersion` to
 * make the write conditional (used by the approval fence and on_event effects).
 *
 * Reads-merge-writes in a tight re-read loop rather than a DB-side jsonb merge so
 * it works through PostgREST; the version check is what prevents lost updates.
 */
export async function mergeCaseState(
  caseId: string,
  merge: CaseStateMerge,
  expectedVersion?: number
): Promise<CaseStateResult> {
  const supabase = getSupabase();

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: item, error: readErr } = await supabase
      .from('work_items')
      .select('agent_state, extracted_data, state_version')
      .eq('id', caseId)
      .single();
    if (readErr || !item) return { ok: false, version: -1 };

    const current = item.state_version ?? 0;
    if (expectedVersion !== undefined && current !== expectedVersion) {
      return { ok: false, version: current, conflict: true };
    }

    const nextState: Record<string, unknown> = { ...(item.agent_state ?? {}) };
    for (const key of merge.clear ?? []) delete nextState[key];
    Object.assign(nextState, merge.set ?? {});

    const update: Record<string, unknown> = {
      agent_state: nextState,
      state_version: current + 1,
      updated_at: new Date().toISOString(),
    };
    if (merge.mergeExtracted && Object.keys(merge.mergeExtracted).length > 0) {
      update.extracted_data = { ...(item.extracted_data ?? {}), ...merge.mergeExtracted };
    }

    const { data: updated, error: writeErr } = await supabase
      .from('work_items')
      .update(update)
      .eq('id', caseId)
      .eq('state_version', current)
      .select('state_version');

    if (!writeErr && updated && updated.length > 0) {
      return { ok: true, version: current + 1 };
    }
    // Lost the optimistic race — re-read and retry (unless caller pinned a version).
    if (expectedVersion !== undefined) {
      return { ok: false, version: current, conflict: true };
    }
  }
  return { ok: false, version: -1, conflict: true };
}

/** Read a path like 'state.response_received' / 'extracted.authorization' / 'case.type'. */
export function readCasePath(item: WorkItem, path: string): unknown {
  const [root, ...rest] = path.split('.');
  let base: unknown;
  if (root === 'state') base = item.agent_state;
  else if (root === 'extracted') base = item.extracted_data;
  else if (root === 'case') base = item as unknown as Record<string, unknown>;
  else return undefined;
  let cur: unknown = base;
  for (const key of rest) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Read a path from an arbitrary payload object ('payload.x.y' or 'x.y'). */
export function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  const parts = path.startsWith('payload.') ? path.slice('payload.'.length).split('.') : path.split('.');
  let cur: unknown = payload;
  for (const key of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

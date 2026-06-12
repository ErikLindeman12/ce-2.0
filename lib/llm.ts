/**
 * lib/llm.ts — model-agnostic reasoning helper (the planner).
 *
 * reason(input) → Decision
 *
 * If ANTHROPIC_API_KEY is set AND agent.model !== 'heuristic':
 *   call Anthropic Messages API with a JSON-output prompt (the agent's named
 *   policies are serialized into the system prompt so the LLM sees the same
 *   policy as the heuristic engine); parse strictly; fall back to heuristic
 *   on any error.
 *
 * Otherwise (default): the GENERIC SKILL LIBRARY — a deterministic,
 * first-match-wins planner gated ONLY on (tool allowlist ∩ presence of named
 * config ∩ state predicates ∩ triggering event type). It never references
 * workflow-specific literals (no case types, no queue keys) — workflow
 * knowledge lives entirely in agent config. Fully powers the demo with no
 * API key.
 */

import { readCasePath } from './caseState';
import { buildChannelPlan } from './outbound';
import { getSupabase } from './supabase';
import type {
  Agent,
  ChasePlan,
  Cond,
  Decision,
  Patient,
  Pred,
  ReasoningInput,
  RequirementSpec,
  WorkItem,
} from './types';

// ---------------------------------------------------------------------------
// Heuristic sub-engines (classification / extraction / patient match)
// ---------------------------------------------------------------------------

/**
 * Match keywords for document classification.
 *
 * `rules` (agent config.classify_rules) are checked FIRST as case-insensitive
 * regexes — they extend/override the builtin keyword map.
 */
export function classifyHeuristic(
  text: string,
  rules?: Array<{ matches: string; type: string }>,
): { type: string; confidence: number } {
  const t = text.toLowerCase();

  // User-configured rules win over the builtin map (first match)
  for (const rule of rules ?? []) {
    if (!rule?.matches || !rule?.type) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.matches, 'i');
    } catch {
      continue; // bad user regex — skip the rule
    }
    if (re.test(text)) {
      const conf = /patient:|dob:|from:|reason:|npi/.test(t) ? 0.95 : 0.9;
      return { type: rule.type, confidence: conf };
    }
  }

  // High-confidence referral keywords
  if (/\breferral\b/.test(t) || /\breferral request\b/.test(t)) {
    const conf = /patient:|dob:|from:|reason:|npi/.test(t) ? 0.95 : 0.88;
    return { type: 'referral', confidence: conf };
  }

  // High-confidence ROI keywords
  if (
    /release of information/.test(t) ||
    /records request/.test(t) ||
    /\broi\b/.test(t) ||
    /message_type.*release/.test(t)
  ) {
    const conf = /patient:|dob:|authorization/.test(t) ? 0.94 : 0.87;
    return { type: 'records_request_in', confidence: conf };
  }

  // Low confidence — unknown
  return { type: 'unknown', confidence: 0.3 };
}

/** Per-field metadata shape stored in agent_state.extraction_meta */
export interface ExtractionFieldMeta {
  confidence: number;
  sourceLine: number;
}

export interface ExtractionMeta {
  fields: Record<string, ExtractionFieldMeta>;
}

/** Extract labeled fields from text, also computing per-field extraction_meta */
export function extractHeuristic(text: string): {
  fields: Record<string, string>;
  confidence: number;
  extraction_meta: ExtractionMeta;
} {
  const fields: Record<string, string> = {};
  const metaFields: Record<string, ExtractionFieldMeta> = {};
  const lines = text.split('\n');

  /** Find 0-based line index for a value in a specific field */
  function sourceLine(value: string): number {
    const idx = lines.findIndex((l) => l.includes(value));
    return idx >= 0 ? idx : 0;
  }

  // Try JSON-ish DM format first
  const jsonPatientMatch = /"first_name"\s*:\s*"([^"]+)"/.exec(text);
  if (jsonPatientMatch) {
    const firstName = jsonPatientMatch[1];
    const lastName = (/"last_name"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const dob = (/"dob"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const mrn = (/"mrn"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const recordsReq = (/"records_requested"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const auth = (/"authorization"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const returnChannel = (/"return_channel"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';
    const returnAddress = (/"return_address"\s*:\s*"([^"]+)"/.exec(text) ?? [])[1] ?? '';

    // JSON-ish DM fields get confidence 0.97
    if (firstName) { fields['patient_first_name'] = firstName; metaFields['patient_first_name'] = { confidence: 0.97, sourceLine: sourceLine(firstName) }; }
    if (lastName)  { fields['patient_last_name']  = lastName;  metaFields['patient_last_name']  = { confidence: 0.97, sourceLine: sourceLine(lastName) }; }
    if (dob)       { fields['patient_dob']         = dob;       metaFields['patient_dob']         = { confidence: 0.97, sourceLine: sourceLine(dob) }; }
    if (mrn)       { fields['patient_mrn']         = mrn;       metaFields['patient_mrn']         = { confidence: 0.97, sourceLine: sourceLine(mrn) }; }
    if (recordsReq){ fields['records_requested']   = recordsReq; metaFields['records_requested']  = { confidence: 0.97, sourceLine: sourceLine(recordsReq) }; }
    if (auth)      { fields['authorization']       = auth;      metaFields['authorization']       = { confidence: 0.97, sourceLine: sourceLine(auth) }; }
    if (returnChannel){ fields['return_channel']   = returnChannel; metaFields['return_channel']  = { confidence: 0.97, sourceLine: sourceLine(returnChannel) }; }
    if (returnAddress){ fields['return_address']   = returnAddress; metaFields['return_address']  = { confidence: 0.97, sourceLine: sourceLine(returnAddress) }; }

    const found = Object.keys(fields).length;
    const confidence = Math.min(0.97, 0.7 + found * 0.04);
    return { fields, confidence, extraction_meta: { fields: metaFields } };
  }

  // CALL SUMMARY block — lines from a structured phone artifact get 0.9
  const inCallSummary = (lineIdx: number): boolean => {
    const summaryStart = lines.findIndex((l) => /CALL SUMMARY/.test(l));
    return summaryStart >= 0 && lineIdx > summaryStart;
  };

  // Labeled-line format (covers both fax labeled lines and CALL SUMMARY lines)
  const labeledPatterns: Array<[string, RegExp]> = [
    ['patient_name', /^Patient:\s*(.+)$/im],
    ['patient_dob', /^DOB:\s*(.+)$/im],
    ['patient_mrn', /^MRN:\s*(.+)$/im],
    ['patient_phone', /^Phone:\s*(.+)$/im],
    ['from_org', /^From:\s*(.+)$/im],
    ['reason', /^Reason:\s*(.+)$/im],
    ['priority', /^Priority:\s*(.+)$/im],
    ['records_requested', /^Records Requested:\s*(.+)$/im],
    ['authorization', /^Authorization:\s*(.+)$/im],
    ['requesting_provider', /^Requesting Provider:\s*(.+)$/im],
    ['caller', /^Caller:\s*(.+)$/im],
    ['callback', /^Callback:\s*(.+)$/im],
  ];

  let found = 0;
  for (const [key, re] of labeledPatterns) {
    const m = re.exec(text);
    if (m) {
      fields[key] = m[1].trim();
      found++;
      const lineIdx = sourceLine(m[1].trim());
      const conf = inCallSummary(lineIdx) ? 0.9 : 0.95;
      metaFields[key] = { confidence: conf, sourceLine: lineIdx };
    }
  }

  // Split patient_name into first/last (inferred split → 0.6)
  if (fields['patient_name']) {
    const parts = fields['patient_name'].split(/\s+/);
    if (parts.length >= 2) {
      const firstLine = metaFields['patient_name']?.sourceLine ?? 0;
      const isCallLine = inCallSummary(firstLine);
      const splitConf = isCallLine ? 0.9 : 0.6;
      fields['patient_first_name'] = parts[0];
      fields['patient_last_name'] = parts.slice(1).join(' ');
      metaFields['patient_first_name'] = { confidence: splitConf, sourceLine: firstLine };
      metaFields['patient_last_name']  = { confidence: splitConf, sourceLine: firstLine };
    }
  }

  if (found === 0) {
    // Messy — no labels found
    return { fields, confidence: 0.15, extraction_meta: { fields: metaFields } };
  }

  let confidence = Math.min(0.9, 0.4 + found * 0.09);
  // Structured machine-generated blocks are reliable even with few fields:
  // CALL SUMMARY (transcription) and PORTAL SUBMISSION (a web form — the
  // sender typed into labeled inputs). Floor their overall score so clean
  // structured artifacts clear the default 0.8 gate while messy OCR never does.
  if (found >= 3 && /CALL SUMMARY/.test(text)) {
    confidence = Math.max(confidence, 0.86);
  }
  if (found >= 3 && /PORTAL SUBMISSION/.test(text)) {
    confidence = Math.max(confidence, 0.92);
  }
  return { fields, confidence, extraction_meta: { fields: metaFields } };
}

/**
 * Match a patient by name+DOB against the MPI.
 *
 * Always returns `candidates` (possibly empty) for ambiguous/fuzzy cases so
 * the runner can attach them to review requests.
 */
export async function matchPatientHeuristic(
  fields: Record<string, string>,
): Promise<{
  patientId: string | null;
  candidates: Patient[];
  confidence: number;
  question?: string;
}> {
  const firstName =
    (fields['patient_first_name'] ?? '').trim().toLowerCase();
  const lastName =
    (fields['patient_last_name'] ?? '').trim().toLowerCase();
  const dob = (fields['patient_dob'] ?? '').trim();
  const mrn = (fields['patient_mrn'] ?? '').trim();

  if (!firstName && !lastName && !mrn) {
    return {
      patientId: null,
      candidates: [],
      confidence: 0.2,
      question: 'No patient name or MRN found in the document. Which patient is this for?',
    };
  }

  const sb = getSupabase();
  let q = sb.from('patients').select('*');

  if (mrn) {
    q = q.eq('mrn', mrn);
  } else {
    if (firstName) q = q.ilike('first_name', firstName);
    if (lastName) q = q.ilike('last_name', lastName);
  }

  const { data, error } = await q;
  if (error || !data) {
    return {
      patientId: null,
      candidates: [],
      confidence: 0.2,
      question: 'MPI lookup failed. Please manually identify the patient.',
    };
  }

  const patients = data as Patient[];

  if (patients.length === 0) {
    // Fuzzy retry: loosen first name to first 3 chars, keep exact last name
    if (firstName.length >= 3 && lastName) {
      const fuzzyFirst = firstName.slice(0, 3) + '%';
      const { data: fuzzyData } = await sb
        .from('patients')
        .select('*')
        .ilike('first_name', fuzzyFirst)
        .ilike('last_name', lastName);
      const fuzzyPatients = (fuzzyData ?? []) as Patient[];
      if (fuzzyPatients.length === 1) {
        const p = fuzzyPatients[0];
        return {
          patientId: null,
          candidates: fuzzyPatients,
          confidence: 0.6,
          question: `Closest MPI match is ${p.first_name} ${p.last_name} (DOB ${p.dob}, MRN ${p.mrn}) — is this the right patient?`,
        };
      }
    }
    return {
      patientId: null,
      candidates: [],
      confidence: 0.2,
      question: `No patient found matching "${firstName} ${lastName}". Please identify the correct patient.`,
    };
  }

  if (patients.length === 1) {
    const p = patients[0];
    // Exact name + DOB match → 0.97; name only → 0.85; MRN exact → 0.97
    if (mrn && p.mrn === mrn) {
      return { patientId: p.id, candidates: patients, confidence: 0.97 };
    }
    if (dob && p.dob === dob) {
      return { patientId: p.id, candidates: patients, confidence: 0.97 };
    }
    // Name only match
    return { patientId: p.id, candidates: patients, confidence: 0.85 };
  }

  // Multiple candidates — check if DOB disambiguates
  if (dob) {
    const exact = patients.filter((p) => p.dob === dob);
    if (exact.length === 1) {
      return { patientId: exact[0].id, candidates: patients, confidence: 0.97 };
    }
  }

  // Ambiguous — two or more candidates
  const dobList = patients
    .map((p) => `DOB ${p.dob}`)
    .join(' vs ');
  const displayName = `${patients[0].first_name} ${patients[0].last_name}`.trim();
  return {
    patientId: null,
    candidates: patients,
    confidence: 0.45,
    question: `${patients.length} patients named ${displayName} (${dobList}). Which one?`,
  };
}

// ---------------------------------------------------------------------------
// Send tool picker
// ---------------------------------------------------------------------------

/** Channel preference fallback order for send tools */
const SEND_TOOL_ORDER = ['send_fax', 'send_email', 'send_sms', 'place_call'] as const;

/** Map a channel name to its send tool */
function toolForChannel(channel: string): string {
  if (channel === 'voice' || channel === 'phone') return 'place_call';
  if (channel === 'care_everywhere') return 'send_care_everywhere';
  return `send_${channel}`;
}

/**
 * Pick the first allowed send tool, optionally preferring a channel.
 * voice → 'place_call', care_everywhere → 'send_care_everywhere',
 * else send_<channel>; fallback order send_fax, send_email, send_sms,
 * place_call filtered by the allowlist.
 */
export function pickSendTool(
  allowedTools: string[],
  channel?: string,
): string | null {
  // Try preferred channel first (portal is never an outbound send channel)
  if (channel && channel !== 'portal') {
    const preferred = toolForChannel(channel);
    if (allowedTools.includes(preferred)) return preferred;
    // 'send_voice' is an allowlist alias of place_call
    if (preferred === 'place_call' && allowedTools.includes('send_voice')) return 'send_voice';
  }
  // Fall back through ordered list
  for (const tool of SEND_TOOL_ORDER) {
    if (allowedTools.includes(tool)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Predicate DSL evaluator (complete_when / requirements / send_policy.when)
// ---------------------------------------------------------------------------

/** Loose scalar equality: strict first, then stringified primitives. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

/** Presence check: undefined/null/'' all count as absent. */
function valueExists(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Evaluate one Pred against case paths (state.x / extracted.x / case.x). */
function evalPred(item: WorkItem, pred: Pred): boolean {
  const value = readCasePath(item, pred.path);
  switch (pred.op) {
    case 'eq':
      return looseEq(value, pred.value);
    case 'neq':
      return !looseEq(value, pred.value);
    case 'exists':
      return valueExists(value);
    case 'absent':
      return !valueExists(value);
    case 'matches':
    case 'not_matches': {
      let re: RegExp;
      try {
        re = new RegExp(String(pred.value ?? ''), 'i');
      } catch {
        return false; // bad user regex — never matches (and never not_matches)
      }
      const hit = re.test(String(value ?? ''));
      return pred.op === 'matches' ? hit : !hit;
    }
    case 'in':
      return Array.isArray(pred.value) && pred.value.some((v) => looseEq(v, value));
    default:
      return false;
  }
}

/** Evaluate a Cond {all/any}. Missing/empty cond is vacuously true. */
function evalCond(item: WorkItem, cond?: Cond): boolean {
  if (!cond) return true;
  const allOk = (cond.all ?? []).every((p) => evalPred(item, p));
  const anyOk = cond.any && cond.any.length > 0 ? cond.any.some((p) => evalPred(item, p)) : true;
  return allOk && anyOk;
}

/** Render {{state.x}} / {{extracted.x}} / {{case.id8}} templates from case paths. */
function renderTemplate(item: WorkItem, template: string): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, token: string) => {
    if (token === 'case.id8') return item.id.slice(0, 8).toUpperCase();
    const value = readCasePath(item, token);
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * All configured requirement flags verified true?
 * - state.requirements present → every configured flag must be true
 *   (every flag at all if no config list).
 * - state.requirements absent → pass only if NO requirements are configured.
 */
function allRequirementFlagsTrue(
  agentState: Record<string, unknown>,
  requirements: RequirementSpec[] | undefined,
): boolean {
  const flags = agentState['requirements'] as Record<string, boolean> | undefined;
  if (flags === undefined) return !requirements || requirements.length === 0;
  if (requirements && requirements.length > 0) {
    return requirements.every((spec) => flags[spec.flag] === true);
  }
  return Object.values(flags).every((v) => v === true);
}

/** Load org channels+contact for buildChannelPlan (chase ladder init). */
async function loadOrgForPlan(orgId: string | null): Promise<{
  channels?: string[];
  contact?: {
    fax?: string;
    email?: string;
    phone?: string;
    preferred_channel?: string;
    chase_policy?: { steps?: string[]; waitSeconds?: number };
  };
} | null> {
  if (!orgId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('organizations')
    .select('id,name,contact,channels')
    .eq('id', orgId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.log('[llm.org_lookup_failed]', JSON.stringify({ orgId, error: error.message }));
    return null;
  }
  return data as {
    channels?: string[];
    contact?: {
      fax?: string;
      email?: string;
      phone?: string;
      preferred_channel?: string;
      chase_policy?: { steps?: string[]; waitSeconds?: number };
    };
  };
}

// ---------------------------------------------------------------------------
// GENERIC SKILL LIBRARY — first-match-wins planner.
// Each skill is gated ONLY on (tool allowlist ∩ presence of named config ∩
// state predicates ∩ triggering event type). No case-type or queue literals.
// ---------------------------------------------------------------------------

const DEFAULT_MORE_INFO_MESSAGE =
  'Missing patient authorization. Please provide signed authorization form.';

async function heuristicDecision(input: ReasoningInput): Promise<Decision> {
  const { workItem, agent, event } = input;
  const tools = agent.tools;
  const config = agent.config ?? {};
  const text = workItem.source_text ?? '';
  const extracted = workItem.extracted_data as Record<string, string>;
  const agentState = workItem.agent_state as Record<string, unknown>;
  const confidence = workItem.confidence as Record<string, number>;

  // -----------------------------------------------------------------------
  // S0 — complete_when: declared outcomes are evaluated before everything
  // -----------------------------------------------------------------------
  if (Array.isArray(config.complete_when)) {
    for (const spec of config.complete_when) {
      if (!spec?.when || !spec?.outcome) continue;
      if (evalCond(workItem, spec.when)) {
        const params: Record<string, unknown> = { result: spec.outcome.result };
        if (spec.outcome.note) params['note'] = renderTemplate(workItem, spec.outcome.note);
        return {
          action: 'report_result',
          params,
          confidence: 0.98,
          rationale: `complete_when condition met — reporting result "${spec.outcome.result}"`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // S1 — classify: tool allowed AND confidence.classify absent
  // -----------------------------------------------------------------------
  if (tools.includes('classify_document') && confidence['classify'] === undefined) {
    const rules = config.classify_rules;
    const { type, confidence: conf } = classifyHeuristic(text, rules);
    const params: Record<string, unknown> = { document_type: type };
    if (rules && rules.length > 0) params['classify_rules'] = rules;
    return {
      action: 'classify_document',
      params,
      confidence: conf,
      rationale: `Heuristic classification: ${type} (confidence ${conf.toFixed(2)})`,
    };
  }

  // -----------------------------------------------------------------------
  // S2 — extract: tool allowed AND confidence.extract absent
  // -----------------------------------------------------------------------
  if (tools.includes('extract_fields') && confidence['extract'] === undefined) {
    const { fields, confidence: conf, extraction_meta } = extractHeuristic(text);
    return {
      action: 'extract_fields',
      params: { fields, extraction_meta },
      confidence: conf,
      rationale: `Heuristic extraction: found ${Object.keys(fields).length} fields (confidence ${conf.toFixed(2)})`,
    };
  }

  // -----------------------------------------------------------------------
  // S3 — match: tool allowed AND no matched patient. Candidates ride along
  //       so the runner can attach them to a review request.
  // -----------------------------------------------------------------------
  if (tools.includes('match_patient') && !workItem.matched_patient_id) {
    const result = await matchPatientHeuristic(extracted);
    return {
      action: 'match_patient',
      params: {
        patient_id: result.patientId,
        patientId: result.patientId,
        candidates: result.candidates,
      },
      confidence: result.confidence,
      rationale: `Heuristic patient match: confidence ${result.confidence.toFixed(2)}`,
      question: result.question,
    };
  }

  // -----------------------------------------------------------------------
  // S4 — verify: tool allowed AND config.requirements present AND not yet
  //       verified. The tool is a generic predicate evaluator over the specs.
  // -----------------------------------------------------------------------
  if (
    tools.includes('verify_requirements') &&
    Array.isArray(config.requirements) &&
    config.requirements.length > 0 &&
    agentState['requirements'] === undefined
  ) {
    return {
      action: 'verify_requirements',
      params: { requirements: config.requirements },
      confidence: 0.95,
      rationale: `Verifying ${config.requirements.length} configured requirement(s)`,
    };
  }

  // -----------------------------------------------------------------------
  // S5 — request-missing: a verified requirement failed. Send a follow-up
  //       (once), then wait; escalate when max_requests is exhausted.
  // -----------------------------------------------------------------------
  const reqSpecs = Array.isArray(config.requirements) ? config.requirements : undefined;
  const reqFlags = agentState['requirements'] as Record<string, boolean> | undefined;
  if (reqSpecs && reqSpecs.length > 0 && reqFlags !== undefined) {
    const failingSpec = reqSpecs.find((spec) => reqFlags[spec.flag] !== true);
    if (failingSpec) {
      if (agentState['more_info_sent']) {
        const maxRequests = failingSpec.on_missing?.max_requests;
        const count = (agentState['more_info_count'] as number | undefined) ?? 1;
        if (maxRequests !== undefined && count >= maxRequests) {
          const question = 'Still missing after follow-up — handle manually?';
          return {
            action: 'request_human_review',
            params: { question },
            confidence: 0.95,
            rationale: `Requirement "${failingSpec.flag}" still failing after ${count} request(s) (max ${maxRequests})`,
            question,
          };
        }
        return {
          action: 'wait',
          params: {},
          confidence: 0.99,
          rationale: `More-info request outstanding for "${failingSpec.flag}" — waiting for response`,
        };
      }
      if (tools.includes('request_more_info')) {
        const message = failingSpec.on_missing?.message ?? DEFAULT_MORE_INFO_MESSAGE;
        return {
          action: 'request_more_info',
          params: { message, reason: message },
          confidence: 0.92,
          rationale: `Requirement "${failingSpec.flag}" failed — requesting missing information`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // S6 — send-per-policy: config.send_policy present, its condition passes
  //       (explicit `when` or all requirement flags true), and the set_flag
  //       hasn't been set yet.
  // -----------------------------------------------------------------------
  if (config.send_policy) {
    const policy = config.send_policy;
    const condOk = policy.when
      ? evalCond(workItem, policy.when)
      : allRequirementFlagsTrue(agentState, reqSpecs);
    const notYetSent = policy.set_flag ? !agentState[policy.set_flag] : true;
    if (condOk && notYetSent) {
      const preferredChannel =
        (workItem.org?.contact?.preferred_channel as string | undefined) ??
        (extracted['return_channel'] as string | undefined) ??
        (agentState['org_preferred_channel'] as string | undefined);
      const sendTool = pickSendTool(tools, preferredChannel);
      if (sendTool) {
        return {
          action: sendTool,
          params: { state_flag: policy.set_flag, document_kind: policy.document_kind },
          confidence: 0.93,
          rationale: `Send policy satisfied — sending ${policy.document_kind} via ${sendTool}`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // S7 — chase ladder: config.chase_policy present. Initializes the plan
  //       from org + config when absent (the SEND carries it as
  //       params.chase_plan for the send tool to persist), then walks the
  //       steps via state.attempt_no; exhausted → human review.
  //       Skipped on response.received — S0 handles arrivals.
  // -----------------------------------------------------------------------
  if (config.chase_policy && event?.type !== 'response.received') {
    const rawPlan = agentState['chase_plan'] as
      | { steps?: Array<{ channel: string; attempt: number }>; channels?: string[]; waitSeconds?: number }
      | undefined;

    // Normalize: new {steps} shape, legacy {channels} shape, or compute fresh
    let steps: Array<{ channel: string; attempt: number }> | undefined = rawPlan?.steps;
    if ((!steps || steps.length === 0) && rawPlan?.channels?.length) {
      const counter: Record<string, number> = {};
      steps = rawPlan.channels.map((ch) => {
        counter[ch] = (counter[ch] ?? 0) + 1;
        return { channel: ch, attempt: counter[ch] };
      });
    }
    let freshPlan: ChasePlan | undefined;
    if (!steps || steps.length === 0) {
      const org = await loadOrgForPlan(workItem.org_id);
      freshPlan = buildChannelPlan(org ?? {}, config);
      steps = freshPlan.steps;
    }

    const idx = (agentState['attempt_no'] as number | undefined) ?? 0;
    if (idx < steps.length) {
      const channel = steps[idx].channel;
      const sendTool = pickSendTool(tools, channel);
      if (sendTool) {
        const params: Record<string, unknown> = {};
        if (freshPlan) params['chase_plan'] = freshPlan;
        return {
          action: sendTool,
          params,
          confidence: 0.9,
          rationale: `Chase ladder step ${idx + 1}/${steps.length} — sending via ${channel}`,
        };
      }
    } else {
      const question =
        config.chase_policy.on_exhausted?.question ??
        `No response after ${idx} attempts (${steps.map((s) => s.channel).join(', ')}) — call them or close?`;
      return {
        action: 'request_human_review',
        params: { question },
        confidence: 0.95,
        rationale: `Chase ladder exhausted after ${idx} attempt(s)`,
        question,
      };
    }
  }

  // -----------------------------------------------------------------------
  // S8 — wait fallback
  // -----------------------------------------------------------------------
  return {
    action: 'wait',
    params: {},
    confidence: 0.99,
    rationale: 'Nothing to do',
  };
}

// ---------------------------------------------------------------------------
// Anthropic API call (used only when key is present and model != 'heuristic')
// ---------------------------------------------------------------------------

/** Serialize the agent's named policies so the LLM sees the same policy as the heuristic engine. */
function serializePolicies(agent: Agent): string {
  const config = agent.config ?? {};
  const lines: string[] = [];
  if (config.complete_when) lines.push(`complete_when: ${JSON.stringify(config.complete_when)}`);
  if (config.requirements) lines.push(`requirements: ${JSON.stringify(config.requirements)}`);
  if (config.send_policy) lines.push(`send_policy: ${JSON.stringify(config.send_policy)}`);
  if (config.chase_policy) lines.push(`chase_policy: ${JSON.stringify(config.chase_policy)}`);
  if (config.classify_rules) lines.push(`classify_rules: ${JSON.stringify(config.classify_rules)}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

async function callAnthropic(input: ReasoningInput): Promise<Decision> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = input.agent.model;

  const systemPrompt = `You are an AI agent for a healthcare work queue system.
Your job is to decide the single next action for a work item.
Respond ONLY with valid JSON matching this schema:
{"action":"<tool_name_or_completion_verb>","params":{},"confidence":<0-1>,"rationale":"<string>","question":"<optional string>"}
Available tools: ${input.agent.tools.join(', ')}
Legal completion verbs (use exactly one per turn when no tool applies):
- report_result — the case outcome is reached; params {"result":"<string>","note":"<optional string>"}
- request_human_review — a human must decide; set "question"
- emit_event — emit a follow-up event; params {"type":"<event_type>","payload":{}}
- wait — nothing to do right now
Agent named policies (these gate your behavior — honor them exactly):
${serializePolicies(input.agent)}
Agent instructions: ${input.agent.instructions}`;

  const userContent = `Work item:
Type: ${input.workItem.type}
Queue: ${input.workItem.queue_key}
Status: ${input.workItem.status}
Source text:
${input.workItem.source_text ?? '(none)'}

Extracted data:
${JSON.stringify(input.workItem.extracted_data, null, 2)}

Agent state:
${JSON.stringify(input.workItem.agent_state, null, 2)}

Confidence so far:
${JSON.stringify(input.workItem.confidence, null, 2)}

Activating event: ${input.event ? `${input.event.type} ${JSON.stringify(input.event.payload)}` : '(manual run)'}

Steps already taken in this run: ${input.stepHistory.join(', ') || 'none'}

What is the next action?`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: userContent }],
      system: systemPrompt,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Strict JSON parse
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) throw new Error('No JSON object in Anthropic response');
  const decision = JSON.parse(jsonMatch[0]) as Decision;
  if (!decision.action || typeof decision.confidence !== 'number') {
    throw new Error('Invalid Decision shape from Anthropic');
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function reason(input: ReasoningInput): Promise<Decision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useAnthropic =
    !!apiKey &&
    input.agent.model !== 'heuristic' &&
    input.agent.model !== '';

  if (useAnthropic) {
    try {
      return await callAnthropic(input);
    } catch (err) {
      console.log(
        '[llm.fallback]',
        JSON.stringify({ reason: String(err), itemId: input.workItem.id }),
      );
      // Fall through to heuristic
    }
  }

  return heuristicDecision(input);
}

export type { Agent };

/**
 * lib/llm.ts — model-agnostic reasoning helper.
 *
 * reason(input) → Decision
 *
 * If ANTHROPIC_API_KEY is set AND agent.model !== 'heuristic':
 *   call Anthropic Messages API (claude-haiku-4-5-20251001) with a JSON-output
 *   prompt; parse strictly; fall back to heuristic on any error.
 *
 * Otherwise (default): deterministic heuristic engine — fully powers the demo
 * with no API key.
 */

import { getSupabase } from './supabase';
import type { Agent, Decision, Patient, ReasoningInput, WorkItem } from './types';

// ---------------------------------------------------------------------------
// Heuristic helpers
// ---------------------------------------------------------------------------

/** Match keywords for document classification */
function classifyHeuristic(text: string): { type: string; confidence: number } {
  const t = text.toLowerCase();

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
function extractHeuristic(text: string): {
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

/** Match a patient by name+DOB against the MPI */
async function matchPatientHeuristic(
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
// Generic planner — derives next action from agent.tools + item state.
// First-match-wins per spec §1. Keeps all existing heuristic logic intact.
// ---------------------------------------------------------------------------

/** Channel preference order for send tools */
const SEND_TOOL_ORDER = ['send_fax', 'send_email', 'send_sms', 'place_call'] as const;

/** Pick the first allowed send tool, optionally preferring an org channel */
function pickSendTool(
  allowedTools: string[],
  preferredChannel?: string,
): string | null {
  const channelToTool: Record<string, string> = {
    fax: 'send_fax',
    email: 'send_email',
    sms: 'send_sms',
    voice: 'place_call',
    phone: 'place_call',
  };
  // Try preferred channel first
  if (preferredChannel && preferredChannel !== 'portal') {
    const preferred = channelToTool[preferredChannel];
    if (preferred && allowedTools.includes(preferred)) return preferred;
  }
  // Fall back through ordered list
  for (const tool of SEND_TOOL_ORDER) {
    if (allowedTools.includes(tool)) return tool;
  }
  return null;
}

async function heuristicDecision(input: ReasoningInput): Promise<Decision> {
  const { workItem, agent, stepHistory } = input;
  const tools = agent.tools;
  const alreadyDone = new Set(stepHistory);
  const text = workItem.source_text ?? '';
  const extracted = workItem.extracted_data as Record<string, string>;
  const agentState = workItem.agent_state as Record<string, unknown>;
  const confidence = workItem.confidence as Record<string, number>;

  // -----------------------------------------------------------------------
  // Rule 1: classify_document allowed AND confidence.classify absent
  // -----------------------------------------------------------------------
  if (tools.includes('classify_document') && confidence['classify'] === undefined) {
    const { type, confidence: conf } = classifyHeuristic(text);
    return {
      action: 'classify_document',
      params: { document_type: type },
      confidence: conf,
      rationale: `Heuristic classification: ${type} (confidence ${conf.toFixed(2)})`,
    };
  }

  // -----------------------------------------------------------------------
  // Rule 2: extract_fields allowed AND confidence.extract absent
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
  // Rule 3: match_patient allowed AND no matched_patient_id
  // -----------------------------------------------------------------------
  if (tools.includes('match_patient') && !workItem.matched_patient_id) {
    const result = await matchPatientHeuristic(extracted);
    return {
      action: 'match_patient',
      params: {
        patient_id: result.patientId,
        candidates: result.candidates,
      },
      confidence: result.confidence,
      rationale: `Heuristic patient match: confidence ${result.confidence.toFixed(2)}`,
      question: result.question,
    };
  }

  // -----------------------------------------------------------------------
  // Rule 4: verify_requirements allowed AND records_request_in AND
  //         agent_state.requirements absent
  // -----------------------------------------------------------------------
  if (
    tools.includes('verify_requirements') &&
    workItem.type === 'records_request_in' &&
    agentState['requirements'] === undefined
  ) {
    const hasPatient = !!workItem.matched_patient_id;
    const hasRecords = !!(extracted['records_requested'] as string | undefined);
    const hasAuth =
      !!(extracted['authorization'] as string | undefined) &&
      !/to follow/i.test((extracted['authorization'] as string) ?? '');
    const completeness = [hasPatient, hasRecords, hasAuth].filter(Boolean).length / 3;
    const conf = hasPatient ? 0.95 : 0.5;
    return {
      action: 'verify_requirements',
      params: {
        has_patient: hasPatient,
        has_records: hasRecords,
        has_auth: hasAuth,
        // Store result in agent_state.requirements (tool updated to do this)
        requirements: { has_patient: hasPatient, has_records: hasRecords, has_auth: hasAuth },
      },
      confidence: conf,
      rationale: `Requirements: patient=${hasPatient}, records=${hasRecords}, auth=${hasAuth} — completeness ${(completeness * 100).toFixed(0)}%`,
      question: !hasPatient
        ? 'No matched patient on this records request — verify identity before releasing records.'
        : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Rule 5: request_more_info allowed AND requirements verified with missing
  //         auth AND NOT agent_state.more_info_sent
  // -----------------------------------------------------------------------
  if (
    tools.includes('request_more_info') &&
    agentState['requirements'] !== undefined &&
    !(agentState['requirements'] as Record<string, boolean>)['has_auth'] &&
    !agentState['more_info_sent']
  ) {
    return {
      action: 'request_more_info',
      params: { reason: 'Missing patient authorization. Please provide signed authorization form.' },
      confidence: 0.92,
      rationale: 'Auth missing — sending request_more_info outbound',
    };
  }

  // -----------------------------------------------------------------------
  // Rule 6: Fulfillment send — records_request_in, requirements complete
  //         (has_auth true), NOT agent_state.records_sent
  // -----------------------------------------------------------------------
  if (
    workItem.type === 'records_request_in' &&
    agentState['requirements'] !== undefined &&
    (agentState['requirements'] as Record<string, boolean>)['has_auth'] &&
    !agentState['records_sent']
  ) {
    // Determine preferred channel from org contact (stored in extracted_data or
    // agent_state.return_channel, fallback to fax for the tool picker)
    const preferredChannel =
      (extracted['return_channel'] as string | undefined) ??
      (agentState['org_preferred_channel'] as string | undefined);
    const sendTool = pickSendTool(tools, preferredChannel);
    if (sendTool) {
      return {
        action: sendTool,
        params: { state_flag: 'records_sent' },
        confidence: 0.92,
        rationale: `Requirements verified — sending records via ${sendTool}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 7: Initial outbound for records_request_out (no agent_state.attempt_no)
  // Reads both the new {steps:[{channel},...]} shape and legacy {channels:[...]} shape.
  // -----------------------------------------------------------------------
  if (
    workItem.type === 'records_request_out' &&
    !agentState['attempt_no'] &&
    !agentState['response_received']
  ) {
    const chasePlan = agentState['chase_plan'] as
      | { steps?: Array<{ channel: string; attempt: number }>; channels?: string[] }
      | undefined;
    // Prefer new steps shape, fall back to legacy channels
    const firstChannel =
      chasePlan?.steps?.[0]?.channel ??
      chasePlan?.channels?.[0];

    // care_everywhere is handled by the Records Chaser via send_care_everywhere tool
    // but since that tool is not in the registry, skip the normal send_tool picker.
    // The ROI route already creates the initial attempt; agent should just wait
    // for response and then mark_complete. So return 'wait' for care_everywhere.
    if (firstChannel === 'care_everywhere') {
      // No tool call needed — attempt already created by compose route
      return {
        action: 'wait',
        params: {},
        confidence: 0.99,
        rationale: 'Care Everywhere attempt already sent — waiting for C-CDA return',
      };
    }

    const sendTool = pickSendTool(tools, firstChannel);
    if (sendTool) {
      return {
        action: sendTool,
        params: {},
        confidence: 0.9,
        rationale: 'Fresh outgoing ROI — sending initial request via preferred channel',
      };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 8: mark_complete allowed AND
  //   (records_request_out with response_received, OR records_request_in with records_sent)
  // -----------------------------------------------------------------------
  if (tools.includes('mark_complete')) {
    if (
      workItem.type === 'records_request_out' &&
      agentState['response_received'] &&
      !alreadyDone.has('mark_complete')
    ) {
      const refNo = `ROI-${workItem.id.slice(0, 8).toUpperCase()}`;
      const lastChannel = (agentState['last_channel'] as string | undefined) ?? 'unknown';
      return {
        action: 'mark_complete',
        params: { note: `Records received via ${lastChannel} — ref ${refNo}.` },
        confidence: 0.98,
        rationale: 'Response received — marking complete',
      };
    }
    if (
      workItem.type === 'records_request_in' &&
      agentState['records_sent'] &&
      !alreadyDone.has('mark_complete')
    ) {
      return {
        action: 'mark_complete',
        params: { note: 'Records sent to requester.' },
        confidence: 0.98,
        rationale: 'Records sent — marking complete',
      };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 9: advance_stage allowed AND queue is intake AND type known
  // -----------------------------------------------------------------------
  if (
    tools.includes('advance_stage') &&
    workItem.queue_key === 'intake' &&
    !alreadyDone.has('advance_stage') &&
    !alreadyDone.has('escalate_to_human')
  ) {
    const itemType = workItem.type;
    const targetQueue =
      itemType === 'referral'
        ? 'referrals'
        : itemType === 'records_request_in'
          ? 'roi_incoming'
          : null;

    if (targetQueue) {
      return {
        action: 'advance_stage',
        params: { queue_key: targetQueue, type: itemType },
        confidence: 0.95,
        rationale: `Routing ${itemType} to ${targetQueue}`,
      };
    }

    if (tools.includes('escalate_to_human')) {
      return {
        action: 'escalate_to_human',
        params: {
          question: 'Unknown document type after classification — cannot route automatically.',
        },
        confidence: 0.95,
        rationale: 'Unknown type, escalating',
      };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 10: wait fallback
  // -----------------------------------------------------------------------
  return {
    action: 'wait',
    params: {},
    confidence: 0.99,
    rationale: 'No applicable step right now — waiting',
  };
}

// ---------------------------------------------------------------------------
// Anthropic API call (used only when key is present and model != 'heuristic')
// ---------------------------------------------------------------------------

async function callAnthropic(input: ReasoningInput): Promise<Decision> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = input.agent.model;

  const systemPrompt = `You are an AI agent for a healthcare work queue system.
Your job is to decide the single next action for a work item.
Respond ONLY with valid JSON matching this schema:
{"action":"<tool_name>","params":{},"confidence":<0-1>,"rationale":"<string>","question":"<optional string>"}
Available tools: ${input.agent.tools.join(', ')}
Agent instructions: ${input.agent.instructions}`;

  const userContent = `Work item:
Type: ${input.workItem.type}
Queue: ${input.workItem.queue_key}
Status: ${input.workItem.status}
Source text:
${input.workItem.source_text ?? '(none)'}

Extracted data:
${JSON.stringify(input.workItem.extracted_data, null, 2)}

Confidence so far:
${JSON.stringify(input.workItem.confidence, null, 2)}

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

// Re-export so agentRunner doesn't need to reach into this module's internals
export { matchPatientHeuristic };
export type { Agent };

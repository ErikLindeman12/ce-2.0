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

/** Extract labeled fields from text */
function extractHeuristic(text: string): {
  fields: Record<string, string>;
  confidence: number;
} {
  const fields: Record<string, string> = {};

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

    if (firstName) fields['patient_first_name'] = firstName;
    if (lastName) fields['patient_last_name'] = lastName;
    if (dob) fields['patient_dob'] = dob;
    if (mrn) fields['patient_mrn'] = mrn;
    if (recordsReq) fields['records_requested'] = recordsReq;
    if (auth) fields['authorization'] = auth;
    if (returnChannel) fields['return_channel'] = returnChannel;
    if (returnAddress) fields['return_address'] = returnAddress;

    const found = Object.keys(fields).length;
    const confidence = Math.min(0.97, 0.7 + found * 0.04);
    return { fields, confidence };
  }

  // Labeled-line format
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
  ];

  let found = 0;
  for (const [key, re] of labeledPatterns) {
    const m = re.exec(text);
    if (m) {
      fields[key] = m[1].trim();
      found++;
    }
  }

  // Split patient_name into first/last
  if (fields['patient_name']) {
    const parts = fields['patient_name'].split(/\s+/);
    if (parts.length >= 2) {
      fields['patient_first_name'] = parts[0];
      fields['patient_last_name'] = parts.slice(1).join(' ');
    }
  }

  if (found === 0) {
    // Messy — no labels found
    return { fields, confidence: 0.15 };
  }

  const confidence = Math.min(0.9, 0.4 + found * 0.09);
  return { fields, confidence };
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
// Heuristic decision engine — called per step of the agent pipeline
// ---------------------------------------------------------------------------

async function heuristicDecision(input: ReasoningInput): Promise<Decision> {
  const { workItem, agent, stepHistory } = input;
  const alreadyDone = new Set(stepHistory);
  const text = workItem.source_text ?? '';
  const extracted = workItem.extracted_data as Record<string, string>;

  // --- INTAKE pipeline ---
  if (agent.queue_key === 'intake') {
    // Step 1: classify
    if (!alreadyDone.has('classify_document')) {
      const { type, confidence } = classifyHeuristic(text);
      return {
        action: 'classify_document',
        params: { document_type: type },
        confidence,
        rationale: `Heuristic classification: ${type} (confidence ${confidence.toFixed(2)})`,
      };
    }

    // Step 2: extract
    if (!alreadyDone.has('extract_fields')) {
      const { fields, confidence } = extractHeuristic(text);
      return {
        action: 'extract_fields',
        params: { fields },
        confidence,
        rationale: `Heuristic extraction: found ${Object.keys(fields).length} fields (confidence ${confidence.toFixed(2)})`,
      };
    }

    // Step 3: match patient
    if (!alreadyDone.has('match_patient')) {
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

    // Step 4: advance stage — only if match confidence was high enough
    if (
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

  // --- ROI INCOMING pipeline ---
  if (agent.queue_key === 'roi_incoming') {
    // Step 1: verify requirements
    if (!alreadyDone.has('verify_requirements')) {
      const hasPatient = !!workItem.matched_patient_id;
      const hasRecords =
        !!(extracted['records_requested'] as string | undefined);
      const hasAuth =
        !!(extracted['authorization'] as string | undefined) &&
        !/to follow/i.test((extracted['authorization'] as string) ?? '');
      const completeness = [hasPatient, hasRecords, hasAuth].filter(Boolean).length / 3;
      // Determining WHICH requirements are missing is a high-confidence finding;
      // what to do about a gap is decided in the next step (request_more_info).
      // Only an unmatched patient is a genuine uncertainty worth escalating here.
      const confidence = hasPatient ? 0.95 : 0.5;
      return {
        action: 'verify_requirements',
        params: { has_patient: hasPatient, has_records: hasRecords, has_auth: hasAuth },
        confidence,
        rationale: `Requirements: patient=${hasPatient}, records=${hasRecords}, auth=${hasAuth} — completeness ${(completeness * 100).toFixed(0)}%`,
        question: !hasPatient ? 'No matched patient on this records request — verify identity before releasing records.' : undefined,
      };
    }

    // Step 2a: request more info if auth missing
    const agentState = workItem.agent_state as Record<string, unknown>;
    if (
      !alreadyDone.has('request_more_info') &&
      !alreadyDone.has('send_fax') &&
      !alreadyDone.has('send_email')
    ) {
      const hasAuth =
        !!(extracted['authorization'] as string | undefined) &&
        !/to follow/i.test((extracted['authorization'] as string) ?? '');
      if (!hasAuth && !agentState['more_info_sent']) {
        return {
          action: 'request_more_info',
          params: { reason: 'Missing patient authorization. Please provide signed authorization form.' },
          confidence: 0.92,
          rationale: 'Auth missing — sending request_more_info outbound',
        };
      }
    }

    // Step 2b: send records back
    if (
      !alreadyDone.has('send_fax') &&
      !alreadyDone.has('send_email') &&
      !alreadyDone.has('mark_complete')
    ) {
      const hasAuth =
        !!(extracted['authorization'] as string | undefined) &&
        !/to follow/i.test((extracted['authorization'] as string) ?? '');
      if (hasAuth) {
        // Decide channel based on org preferred channel — default to fax
        return {
          action: 'send_fax',
          params: { subject: 'Records Response', body: 'Requested records are attached.' },
          confidence: 0.92,
          rationale: 'Requirements verified — sending records via preferred channel',
        };
      }
    }

    // Step 3: mark complete
    if (
      !alreadyDone.has('mark_complete') &&
      (alreadyDone.has('send_fax') || alreadyDone.has('send_email'))
    ) {
      return {
        action: 'mark_complete',
        params: { note: 'Records sent to requester.' },
        confidence: 0.98,
        rationale: 'Records sent — marking complete',
      };
    }
  }

  // --- ROI OUTGOING pipeline ---
  if (agent.queue_key === 'roi_outgoing') {
    const agentState = workItem.agent_state as Record<string, unknown>;

    // Response arrived (tick reopened the item) — close it out
    if (agentState['response_received'] && !alreadyDone.has('mark_complete')) {
      return {
        action: 'mark_complete',
        params: { note: 'Records received.' },
        confidence: 0.98,
        rationale: 'Response received — marking complete',
      };
    }

    // Initial send on a fresh item — agent_state.attempt_no is the durable
    // guard (stepHistory only covers this run; retries are owned by tick()).
    if (
      !agentState['attempt_no'] &&
      !alreadyDone.has('send_fax') &&
      !alreadyDone.has('send_email') &&
      !alreadyDone.has('send_sms') &&
      !alreadyDone.has('place_call')
    ) {
      return {
        action: 'send_fax',
        params: {
          subject: 'Records Request',
          body: 'Please provide the requested records at your earliest convenience.',
        },
        confidence: 0.9,
        rationale: 'Fresh outgoing ROI — sending initial request via preferred channel',
      };
    }
  }

  // Fallback — nothing actionable right now (e.g. awaiting an outbound
  // response). A no-op, NOT an escalation: escalating here would flood
  // Human Review every tick for items that are simply waiting.
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

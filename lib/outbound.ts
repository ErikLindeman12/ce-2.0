/**
 * lib/outbound.ts — outbound document rendering + channel-plan module.
 *
 * buildChannelPlan(org, agentConfig?, override?, waitSeconds?) → ChasePlan
 * renderOutboundDocument(channel, kind, ctx) → { subject, body, document }
 *
 * All content is deterministic — no randomness beyond using the current Date
 * for the date line.
 *
 * W1b changes:
 * - 'care_everywhere' added to Channel union.
 * - buildChannelPlan now returns ChasePlan {steps: ChaseStep[], waitSeconds}
 *   with resolution order: Epic org → care_everywhere; else org chase_policy;
 *   else agent chase_policy; else default ['fax','fax','voice'].
 * - Legacy {channels:[...]} shape is still readable by callers that check for it.
 * - Portal channel removed from new plan resolution (kept for legacy reads).
 */

import type { ChaseStep } from './types';

export type Channel = 'fax' | 'email' | 'sms' | 'voice' | 'portal' | 'care_everywhere';

/** New step-based plan shape (w1b) */
export interface ChasePlan {
  steps: ChaseStep[];
  waitSeconds: number;
}

/** Legacy plan shape — kept for backward-compat reads in existing callers */
export interface ChannelPlan {
  channels: Channel[];
  waitSeconds: number;
}

export type DocumentKind = 'records_request' | 'request_more_info' | 'records_response';

export interface OutboundContext {
  /** The first 8 characters of the work-item UUID — used as the ref number. */
  itemId: string;
  patientName: string;
  patientDob?: string;
  patientMrn?: string;
  recordsRequested?: string;
  orgName: string;
  orgFax?: string;
  orgEmail?: string;
  orgPhone?: string;
  /** 1-based attempt counter — drives "SECOND REQUEST" framing when > 1. */
  attemptNo?: number;
  /** ISO datetime of the previous attempt, used in the "prior … sent" note. */
  priorAttemptAt?: string;
}

export interface RenderedDocument {
  subject: string;
  body: string;
  /** Full artifact text — stored in payload.document, rendered in UI. */
  document: string;
}

// ---------------------------------------------------------------------------
// isEpicOrg — detects Care Everywhere capability
// ---------------------------------------------------------------------------

/**
 * An org is Epic/Care Everywhere-capable if its capabilities.channels
 * (stored as a text[] column "channels") includes 'cloud'.
 */
export function isEpicOrg(org: { channels?: string[] } | { capabilities?: { channels?: string[] } }): boolean {
  const channelArr =
    ('channels' in org && Array.isArray(org.channels))
      ? org.channels
      : ('capabilities' in org && Array.isArray(org.capabilities?.channels))
        ? (org.capabilities?.channels ?? [])
        : [];
  return channelArr.includes('cloud');
}

// ---------------------------------------------------------------------------
// buildChannelPlan — new step-based plan with W1b resolution rules
// ---------------------------------------------------------------------------

/**
 * Build an ordered chase ladder.
 *
 * Resolution order (per workflow1b-revision.md §1):
 *  1. Epic org (capabilities.channels includes 'cloud') → [{channel:'care_everywhere',attempt:1}]
 *  2. Org contact.chase_policy.steps if present
 *  3. Agent config.chase_policy.steps if present
 *  4. Default ['fax','fax','voice']
 *
 * Channel override forces the first step regardless (unless care_everywhere).
 * Steps whose channel has no org contact info are skipped.
 * waitSeconds clamped 10–120.
 */
export function buildChannelPlan(
  org: {
    channels?: string[];
    contact?: {
      fax?: string;
      email?: string;
      phone?: string;
      preferred_channel?: string;
      chase_policy?: { steps?: string[]; waitSeconds?: number };
    };
  },
  agentConfig?: {
    chase_policy?: { steps?: string[]; waitSeconds?: number };
  },
  override?: Channel,
  waitSeconds?: number,
): ChasePlan {
  const contact = org.contact ?? {};

  // --- Step 1: Epic/Care Everywhere orgs ---
  if (isEpicOrg(org) && !override) {
    const wait = Math.min(120, Math.max(10, waitSeconds ?? 30));
    return {
      steps: [{ channel: 'care_everywhere', attempt: 1 }],
      waitSeconds: wait,
    };
  }

  // --- Determine raw step list from policy hierarchy ---
  const orgPolicy = contact.chase_policy;
  const agentPolicy = agentConfig?.chase_policy;

  const rawSteps: string[] =
    orgPolicy?.steps?.length
      ? orgPolicy.steps
      : agentPolicy?.steps?.length
        ? agentPolicy.steps
        : ['fax', 'fax', 'voice'];

  const policyWait =
    orgPolicy?.waitSeconds ??
    agentPolicy?.waitSeconds ??
    waitSeconds ??
    30;

  const wait = Math.min(120, Math.max(10, policyWait));

  // Channels the org actually has contact info for
  const hasChannel: Record<string, boolean> = {
    fax: !!contact.fax,
    email: !!contact.email,
    sms: !!contact.phone,
    voice: !!contact.phone,
    portal: true, // portal never skipped by contact info but filtered later
    care_everywhere: true,
  };

  // If override is set, prepend it and skip the normal first step
  let effectiveRaw = rawSteps;
  if (override && override !== 'care_everywhere') {
    // Replace only the first element if it matches or prepend
    effectiveRaw = [override, ...rawSteps.filter((_, i) => i > 0 || rawSteps[0] !== override)];
  }

  // Expand raw strings into ChaseStep[], tracking per-channel attempt counters
  // and skipping steps with no org contact info (except override which forces inclusion)
  const channelAttemptCounter: Record<string, number> = {};
  const steps: ChaseStep[] = [];

  for (const rawCh of effectiveRaw) {
    const ch = rawCh as Channel;
    // Skip portal in outgoing plans (no longer an outbound channel)
    if (ch === 'portal') continue;
    // Skip if org lacks contact info for this channel (but allow override or care_everywhere)
    if (ch !== override && !hasChannel[ch]) continue;

    channelAttemptCounter[ch] = (channelAttemptCounter[ch] ?? 0) + 1;
    steps.push({ channel: ch, attempt: channelAttemptCounter[ch] });
  }

  // Fallback: if all steps were skipped, use fax
  if (steps.length === 0) {
    steps.push({ channel: 'fax', attempt: 1 });
  }

  return { steps, waitSeconds: wait };
}

/**
 * Legacy compat: return the legacy ChannelPlan shape (deduped channels list).
 * Used by any remaining code that calls buildChannelPlan and reads .channels.
 */
export function buildChannelPlanLegacy(
  org: Parameters<typeof buildChannelPlan>[0],
  agentConfig?: Parameters<typeof buildChannelPlan>[1],
  override?: Channel,
  waitSeconds?: number,
): ChannelPlan {
  const plan = buildChannelPlan(org, agentConfig, override, waitSeconds);
  const seen = new Set<Channel>();
  const channels: Channel[] = [];
  for (const step of plan.steps) {
    if (!seen.has(step.channel)) {
      seen.add(step.channel);
      channels.push(step.channel);
    }
  }
  return { channels: channels.length ? channels : ['fax'], waitSeconds: plan.waitSeconds };
}

// ---------------------------------------------------------------------------
// renderOutboundDocument
// ---------------------------------------------------------------------------

export function renderOutboundDocument(
  channel: Channel,
  kind: DocumentKind,
  ctx: OutboundContext,
): RenderedDocument {
  const refNo = `ROI-${ctx.itemId.slice(0, 8).toUpperCase()}`;
  const dateStr = formatDate(new Date());
  const attemptNo = ctx.attemptNo ?? 1;
  const isRepeat = attemptNo > 1;

  switch (channel) {
    case 'fax':
      return renderFax(kind, ctx, refNo, dateStr, attemptNo, isRepeat);
    case 'email':
      return renderEmail(kind, ctx, refNo, dateStr, attemptNo, isRepeat);
    case 'sms':
      return renderSms(kind, ctx, refNo);
    case 'voice':
      return renderVoice(kind, ctx, refNo, attemptNo);
    case 'portal':
      return renderPortal(kind, ctx, refNo, dateStr);
    case 'care_everywhere':
      return renderCareEverywhere(kind, ctx, refNo, dateStr);
    default:
      return renderFax(kind, ctx, refNo, dateStr, attemptNo, isRepeat);
  }
}

// ---------------------------------------------------------------------------
// Care Everywhere — structured C-CDA query document
// ---------------------------------------------------------------------------

function renderCareEverywhere(
  kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
  dateStr: string,
): RenderedDocument {
  if (kind === 'records_response') {
    // Simulated C-CDA return document
    const doc = [
      '================================================================================',
      '              CARE EVERYWHERE — DOCUMENT RETURN (C-CDA summary)                ',
      '================================================================================',
      '',
      `Date:           ${dateStr}`,
      `From:           ${ctx.orgName} — Epic Care Everywhere Exchange`,
      `To:             CE 2.0 Network Console`,
      `Ref #:          ${refNo}`,
      `Exchange:       Epic Care Everywhere (cloud)`,
      '',
      `Patient:        ${ctx.patientName}`,
      ...(ctx.patientDob ? [`DOB:            ${ctx.patientDob}`] : []),
      ...(ctx.patientMrn ? [`MRN:            ${ctx.patientMrn}`] : []),
      '',
      'Document Type:  C-CDA Continuity of Care Document (CCD)',
      'Format:         HL7 CDA Release 2',
      '',
      'SUMMARY OF TRANSMITTED RECORDS:',
      '  • Active Problem List',
      '  • Medications (current)',
      '  • Allergies and Adverse Reactions',
      '  • Lab Results (last 12 months)',
      '  • Immunization History',
      '  • Vital Signs (last visit)',
      ...(ctx.recordsRequested ? [``, `  Originally requested: ${ctx.recordsRequested}`] : []),
      '',
      'STATUS: Complete — all available records transmitted via Care Everywhere.',
      '',
      `Ref: ${refNo}`,
      '================================================================================',
    ].join('\n');

    const subject = `Care Everywhere Return — ${ctx.patientName} (ref ${refNo})`;
    const body = `C-CDA document return for ${ctx.patientName} via Care Everywhere — ref ${refNo}. Records complete.`;
    return { subject, body, document: doc };
  }

  // records_request — structured Care Everywhere query
  const doc = [
    '================================================================================',
    '                  CARE EVERYWHERE — RECORD QUERY                                ',
    '================================================================================',
    '',
    `Date:           ${dateStr}`,
    `From:           CE 2.0 Network Console`,
    `To:             ${ctx.orgName} — Epic Care Everywhere Exchange`,
    `Ref #:          ${refNo}`,
    `Exchange:       Epic Care Everywhere (cloud — structured exchange)`,
    '',
    '--- PATIENT DEMOGRAPHICS ---',
    `Patient:        ${ctx.patientName}`,
    ...(ctx.patientDob ? [`DOB:            ${ctx.patientDob}`] : []),
    ...(ctx.patientMrn ? [`MRN:            ${ctx.patientMrn}`] : []),
    '',
    '--- RECORDS REQUESTED ---',
    ctx.recordsRequested
      ? `Records:        ${ctx.recordsRequested}`
      : 'Records:        All available (C-CDA Continuity of Care Document)',
    '',
    'Exchange type:  Structured — instant, no fax required.',
    'Expected response: C-CDA document return via Care Everywhere.',
    '',
    `Ref: ${refNo}`,
    '================================================================================',
  ].join('\n');

  const subject = `Care Everywhere Query — ${ctx.patientName} (ref ${refNo})`;
  const body = `Structured Care Everywhere record query for ${ctx.patientName} — ref ${refNo}. Awaiting C-CDA return.`;
  return { subject, body, document: doc };
}

// ---------------------------------------------------------------------------
// Fax cover sheet
// ---------------------------------------------------------------------------

function renderFax(
  kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
  dateStr: string,
  attemptNo: number,
  isRepeat: boolean,
): RenderedDocument {
  const kindLabel = kindToLabel(kind);
  const subject = `${kindLabel} — ${ctx.patientName} (ref ${refNo})`;

  const repeatBanner = isRepeat
    ? `\n*** ${ordinal(attemptNo).toUpperCase()} REQUEST — prior transmission sent ${ctx.priorAttemptAt ? formatDate(new Date(ctx.priorAttemptAt)) : 'previously'} ***\n`
    : '';

  const faxTo = ctx.orgFax ?? 'See address on file';

  const doc = [
    '================================================================================',
    '                        *** FACSIMILE COVER SHEET ***                          ',
    '================================================================================',
    '',
    `TO:         ${ctx.orgName}`,
    `FAX #:      ${faxTo}`,
    `FROM:       CE 2.0 / Network Console — Medical Records Team`,
    `DATE:       ${dateStr}`,
    `RE:         ${kindLabel} — ${ctx.patientName}`,
    `PAGES:      1 (cover) + request letter`,
    `REF #:      ${refNo}`,
    '',
    '--------------------------------------------------------------------------------',
    '  CONFIDENTIALITY NOTICE: This facsimile transmission contains confidential     ',
    '  health information protected by HIPAA. If you received this in error, please  ',
    '  destroy it immediately and notify the sender. Unauthorized disclosure is       ',
    '  prohibited by law.                                                             ',
    '--------------------------------------------------------------------------------',
    '',
    repeatBanner,
    '                           *** REQUEST LETTER ***                               ',
    '',
    `Date: ${dateStr}`,
    ``,
    `To Whom It May Concern at ${ctx.orgName},`,
    ``,
    bodyText(kind, ctx, refNo),
    ``,
    `Patient Information:`,
    `  Name:  ${ctx.patientName}`,
    ...(ctx.patientDob ? [`  DOB:   ${ctx.patientDob}`] : []),
    ...(ctx.patientMrn ? [`  MRN:   ${ctx.patientMrn}`] : []),
    ``,
    replyInstructions(kind, refNo, ctx),
    ``,
    `Reference Number: ${refNo}`,
    `Attempt:          ${attemptNo}`,
    ``,
    `Sincerely,`,
    `CE 2.0 Medical Records Team`,
    '================================================================================',
  ]
    .join('\n')
    .replace(/\n\n\n+/g, '\n\n');

  const body = `${kindLabel} for ${ctx.patientName} — ref ${refNo}. Attempt ${attemptNo}. Please respond via fax to ${faxTo}.`;

  return { subject, body, document: doc };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function renderEmail(
  kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
  dateStr: string,
  attemptNo: number,
  isRepeat: boolean,
): RenderedDocument {
  const kindLabel = kindToLabel(kind);
  const subject = `${kindLabel} — ${ctx.patientName} (ref ${refNo})${isRepeat ? ` [${ordinal(attemptNo)} Request]` : ''}`;

  const repeatNote = isRepeat
    ? `Note: This is a ${ordinal(attemptNo)} request. A prior message was sent ${ctx.priorAttemptAt ? formatDate(new Date(ctx.priorAttemptAt)) : 'previously'}.\n\n`
    : '';

  const doc = [
    `To: ${ctx.orgName} Medical Records`,
    ...(ctx.orgEmail ? [`Email: ${ctx.orgEmail}`] : []),
    `Date: ${dateStr}`,
    `Ref: ${refNo}`,
    '',
    `Dear ${ctx.orgName} Medical Records Team,`,
    '',
    repeatNote + bodyText(kind, ctx, refNo),
    '',
    `Patient: ${ctx.patientName}`,
    ...(ctx.patientDob ? [`DOB: ${ctx.patientDob}`] : []),
    ...(ctx.patientMrn ? [`MRN: ${ctx.patientMrn}`] : []),
    '',
    replyInstructions(kind, refNo, ctx),
    '',
    `Reference: ${refNo} | Attempt: ${attemptNo}`,
    '',
    'Thank you for your prompt attention.',
    '',
    'CE 2.0 Medical Records Team',
    'Network Console',
  ].join('\n');

  const body = `${kindLabel} for ${ctx.patientName} (${refNo}). ${bodyText(kind, ctx, refNo)} Please reply to this email.`;

  return { subject, body, document: doc };
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

function renderSms(
  _kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
): RenderedDocument {
  const subject = `SMS: Records Request ${refNo}`;
  // ≤240 chars
  const text = `CE Network: Records request for ${ctx.patientName} — ref ${refNo}. Please call ${ctx.orgPhone ?? 'us'} or reply to confirm. Ref: ${refNo}`.slice(0, 240);
  return { subject, body: text, document: text };
}

// ---------------------------------------------------------------------------
// Voice script
// ---------------------------------------------------------------------------

function renderVoice(
  kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
  attemptNo: number,
): RenderedDocument {
  const kindLabel = kindToLabel(kind);
  const subject = `Voice: ${kindLabel} — ${ctx.patientName} (ref ${refNo})`;

  const script = [
    `[VOICE CALL SCRIPT — Attempt ${attemptNo}]`,
    '',
    'GREETING:',
    `  "Hello, this is CE 2.0 Network Console calling on behalf of the medical records`,
    `  team. We are trying to reach the medical records department at ${ctx.orgName}."`,
    '',
    'REASON:',
    `  "We have a ${kindLabel.toLowerCase()} on file for patient ${ctx.patientName}`,
    ...(ctx.patientDob ? [`  (date of birth ${ctx.patientDob})`] : []),
    `  and need your assistance to fulfill it."`,
    '',
    'REFERENCE:',
    `  "Our reference number for this request is ${refNo}. Please note this number`,
    `  when you return our call."`,
    '',
    'CALLBACK:',
    `  "Please return this call or contact us using reference ${refNo}.`,
    `  Thank you for your time."`,
    '',
    `[END SCRIPT — Ref: ${refNo} | Attempt: ${attemptNo}]`,
  ].join('\n');

  const body = `Voice call script for ${kindLabel.toLowerCase()} — ${ctx.patientName} — ref ${refNo}`;
  return { subject, body, document: script };
}

// ---------------------------------------------------------------------------
// Portal (legacy — kept for backward compat; no longer in new plans)
// ---------------------------------------------------------------------------

function renderPortal(
  kind: DocumentKind,
  ctx: OutboundContext,
  refNo: string,
  dateStr: string,
): RenderedDocument {
  const kindLabel = kindToLabel(kind);
  const subject = `${kindLabel} — ${ctx.patientName} (ref ${refNo})`;

  const doc = [
    `[IN-APP REQUEST — ${dateStr}]`,
    `Reference: ${refNo}`,
    ``,
    `To: ${ctx.orgName}`,
    ``,
    `This is an in-network ${kindLabel.toLowerCase()} via CE 2.0 Provider Portal.`,
    ``,
    `Patient: ${ctx.patientName}`,
    ...(ctx.patientDob ? [`DOB: ${ctx.patientDob}`] : []),
    ...(ctx.patientMrn ? [`MRN: ${ctx.patientMrn}`] : []),
    ...(ctx.recordsRequested ? [``, `Records Requested: ${ctx.recordsRequested}`] : []),
    ``,
    bodyText(kind, ctx, refNo),
    ``,
    replyInstructions(kind, refNo, ctx),
    ``,
    `Ref: ${refNo}`,
  ].join('\n');

  const body = `${kindLabel} for ${ctx.patientName} — ref ${refNo}. Please respond via the portal.`;
  return { subject, body, document: doc };
}

// ---------------------------------------------------------------------------
// RECORDS TRANSMITTAL — simulated response document
// ---------------------------------------------------------------------------

export function renderRecordsTransmittal(ctx: {
  patientName: string;
  patientDob?: string;
  orgName: string;
  channel: Channel;
  refNo: string;
  dateStr?: string;
}): string {
  const date = ctx.dateStr ?? formatDate(new Date());
  const pageCount = 3 + Math.floor(pseudoRandom(ctx.refNo) * 8); // 3–10 pages, deterministic per ref

  if (ctx.channel === 'care_everywhere') {
    // Care Everywhere response is a C-CDA return
    return [
      '================================================================================',
      '              CARE EVERYWHERE — DOCUMENT RETURN (C-CDA summary)                ',
      '================================================================================',
      '',
      `Date:           ${date}`,
      `From:           ${ctx.orgName} — Epic Care Everywhere Exchange`,
      `To:             CE 2.0 Network Console`,
      `Ref #:          ${ctx.refNo}`,
      '',
      `Patient:        ${ctx.patientName}`,
      ...(ctx.patientDob ? [`DOB:            ${ctx.patientDob}`] : []),
      '',
      'Document Type:  C-CDA Continuity of Care Document (CCD)',
      'Format:         HL7 CDA Release 2',
      '',
      'SUMMARY OF TRANSMITTED RECORDS:',
      '  • Active Problem List',
      '  • Medications (current)',
      '  • Allergies and Adverse Reactions',
      '  • Lab Results (last 12 months)',
      '  • Immunization History',
      '  • Vital Signs (last visit)',
      '',
      'STATUS: Complete — all available records transmitted via Care Everywhere.',
      '',
      `Ref: ${ctx.refNo}`,
      '================================================================================',
    ].join('\n');
  }

  return [
    '================================================================================',
    '                         *** RECORDS TRANSMITTAL ***                           ',
    '================================================================================',
    '',
    `Date:           ${date}`,
    `From:           ${ctx.orgName} — Medical Records Department`,
    `To:             CE 2.0 Network Console`,
    `Ref #:          ${ctx.refNo}`,
    `Channel:        ${ctx.channel.toUpperCase()}`,
    '',
    `Patient:        ${ctx.patientName}`,
    ...(ctx.patientDob ? [`DOB:            ${ctx.patientDob}`] : []),
    '',
    `Records sent:   Clinical summary, lab results, imaging reports`,
    `Date range:     Last 12 months`,
    `Pages:          ${pageCount}`,
    '',
    'This transmittal confirms that all requested records have been released per the',
    'signed patient authorization on file. Records are considered complete.',
    '',
    `Releasing coordinator: Medical Records Dept — ${ctx.orgName}`,
    '================================================================================',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindToLabel(kind: DocumentKind): string {
  switch (kind) {
    case 'records_request':
      return 'Records Request';
    case 'request_more_info':
      return 'Request for Additional Information';
    case 'records_response':
      return 'Records Response';
  }
}

function bodyText(kind: DocumentKind, ctx: OutboundContext, refNo: string): string {
  switch (kind) {
    case 'records_request':
      return (
        `We are writing to request the release of medical records for the above-named patient.` +
        (ctx.recordsRequested ? ` Specifically, we require: ${ctx.recordsRequested}.` : '') +
        ` Please release records at your earliest convenience, citing reference ${refNo}.`
      );
    case 'request_more_info':
      return (
        `We are following up on a prior release-of-information request (ref ${refNo}). ` +
        `To complete processing we require the following additional information:\n` +
        `  • Signed patient authorization form\n` +
        `  • Confirmation of patient identity\n\n` +
        `Please provide the above items at your earliest convenience.`
      );
    case 'records_response':
      return (
        `Enclosed please find the requested medical records for the above-named patient ` +
        `in response to your records request (ref ${refNo}). ` +
        `All documents are released under signed patient authorization.`
      );
  }
}

function replyInstructions(kind: DocumentKind, refNo: string, ctx: OutboundContext): string {
  if (kind === 'records_request' || kind === 'request_more_info') {
    const faxBack = ctx.orgFax ? ` or fax to ${ctx.orgFax}` : '';
    return (
      `To respond, please reference ${refNo} in all correspondence. ` +
      `Reply to this message${faxBack}. A response is requested as soon as possible.`
    );
  }
  return `This is a response to your request — no further action required unless you have questions. Reference: ${refNo}.`;
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Cheap deterministic pseudo-random 0–1 from a string seed. */
function pseudoRandom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) / 2147483647;
}

/**
 * lib/outbound.ts — outbound document rendering + channel-plan module.
 *
 * buildChannelPlan(org, override?, waitSeconds?) → { channels, waitSeconds }
 * renderOutboundDocument(channel, kind, ctx) → { subject, body, document }
 *
 * All content is deterministic — no randomness beyond using the current Date
 * for the date line. The document string is the full artifact stored in
 * payload.document and rendered in the item detail UI.
 */

export type Channel = 'fax' | 'email' | 'sms' | 'voice' | 'portal';

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
// buildChannelPlan
// ---------------------------------------------------------------------------

/**
 * Build an ordered escalation list from the org's actual contact fields.
 *
 * Rules (per spec):
 * - Start with preferred_channel.
 * - If preferred is 'portal' → plan is ['portal'] only.
 * - Otherwise, append the rest of [fax, email, sms, voice] only where the
 *   org has the corresponding contact field.
 * - override forces that channel first, followed by the normal remainder.
 * - waitSeconds defaults 30, clamped 10–120.
 */
export function buildChannelPlan(
  org: {
    contact?: {
      fax?: string;
      email?: string;
      phone?: string;
      preferred_channel?: string;
    };
  },
  override?: Channel,
  waitSeconds?: number,
): ChannelPlan {
  const wait = Math.min(120, Math.max(10, waitSeconds ?? 30));
  const contact = org.contact ?? {};
  const preferred = (contact.preferred_channel ?? 'fax') as Channel;

  // Portal orgs: single step, no chase
  if (preferred === 'portal' && !override) {
    return { channels: ['portal'], waitSeconds: wait };
  }

  // Build ordered list: start with preferred, then add the rest in canonical order
  const canonical: Channel[] = ['fax', 'email', 'sms', 'voice'];

  // Channels the org actually has contact info for
  const hasChannel: Record<string, boolean> = {
    fax: !!contact.fax,
    email: !!contact.email,
    sms: !!contact.phone,
    voice: !!contact.phone,
  };

  let ordered: Channel[] = [];

  if (override) {
    // Override channel goes first, then normal remainder (without override)
    ordered.push(override);
    if (preferred !== override && hasChannel[preferred]) {
      ordered.push(preferred);
    }
    for (const ch of canonical) {
      if (ch !== override && ch !== preferred && hasChannel[ch]) {
        ordered.push(ch);
      }
    }
  } else {
    // Preferred first
    if (hasChannel[preferred]) {
      ordered.push(preferred);
    }
    for (const ch of canonical) {
      if (ch !== preferred && hasChannel[ch]) {
        ordered.push(ch);
      }
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<Channel>();
  const deduped: Channel[] = [];
  for (const ch of ordered) {
    if (!seen.has(ch)) {
      seen.add(ch);
      deduped.push(ch);
    }
  }

  return { channels: deduped.length > 0 ? deduped : ['fax'], waitSeconds: wait };
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
    default:
      return renderFax(kind, ctx, refNo, dateStr, attemptNo, isRepeat);
  }
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
    `================================================================================`,
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
// Portal (in-network)
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

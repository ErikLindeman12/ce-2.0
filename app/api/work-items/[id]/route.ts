import { NextResponse } from 'next/server';
import { getWorkItem } from '@/lib/workItems';
import { toWorkItemSummary } from '@/lib/types';
import type { OutboundAttemptSummary, AuditEntry, PatientSummary } from '@/lib/types';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  try {
    const detail = await getWorkItem(id);
    if (!detail) {
      return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
    }

    const itemSummary = toWorkItemSummary(detail.item);

    const attempts: OutboundAttemptSummary[] = detail.outboundAttempts.map((a) => ({
      id: a.id,
      channel: a.channel,
      attemptNo: a.attempt_no,
      status: a.status,
      toContact: a.to_contact,
      payload: a.payload,
      response: a.response,
      respondAfter: a.respond_after,
      createdAt: a.created_at,
    }));

    const audit: AuditEntry[] = detail.auditTrail.map((e) => ({
      id: e.id,
      actor: e.actor,
      action: e.action,
      detail: e.detail,
      createdAt: e.created_at,
    }));

    const patientCandidates: PatientSummary[] = (detail.patientCandidates ?? []).map((p) => ({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      dob: p.dob,
      mrn: p.mrn,
    }));

    return NextResponse.json({
      data: {
        item: { ...itemSummary, sourceText: detail.item.source_text, agentState: detail.item.agent_state },
        audit,
        attempts,
        patientCandidates,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[work-items.get_failed]', msg);
    return NextResponse.json({ error: 'Failed to get work item' }, { status: 500 });
  }
}

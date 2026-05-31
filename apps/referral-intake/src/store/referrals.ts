import { v4 as uuidv4 } from 'uuid';
import type { Referral, ReferralStatus, CreateReferralInput } from '@ce2/types';

const store = new Map<string, Referral>();

export function createReferral(input: CreateReferralInput): Referral {
  const now = new Date().toISOString();
  const referral: Referral = {
    ...input,
    id: uuidv4(),
    status: 'received',
    createdAt: now,
    updatedAt: now,
    statusHistory: [
      {
        status: 'received',
        timestamp: now,
      },
    ],
  };
  store.set(referral.id, referral);
  return referral;
}

export function getReferral(id: string): Referral | undefined {
  return store.get(id);
}

export interface ReferralFilters {
  fromOrgId?: string;
  toOrgId?: string;
  status?: ReferralStatus;
}

export function listReferrals(filters?: ReferralFilters): Referral[] {
  const all = Array.from(store.values());
  if (!filters) return all;

  return all.filter((r) => {
    if (filters.fromOrgId !== undefined && r.fromOrgId !== filters.fromOrgId) return false;
    if (filters.toOrgId !== undefined && r.toOrgId !== filters.toOrgId) return false;
    if (filters.status !== undefined && r.status !== filters.status) return false;
    return true;
  });
}

export function updateStatus(
  id: string,
  status: ReferralStatus,
  note?: string,
): Referral | undefined {
  const referral = store.get(id);
  if (!referral) return undefined;

  const now = new Date().toISOString();
  const updated: Referral = {
    ...referral,
    status,
    updatedAt: now,
    statusHistory: [
      ...referral.statusHistory,
      {
        status,
        timestamp: now,
        ...(note !== undefined ? { note } : {}),
      },
    ],
  };
  store.set(id, updated);
  return updated;
}

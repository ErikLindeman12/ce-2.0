import { Router, Request, Response, type IRouter } from 'express';
import type { CreateReferralInput, OrgChannel, ReferralStatus } from '@ce2/types';
import {
  createReferral,
  getReferral,
  listReferrals,
  updateStatus,
} from '../store/referrals';
import { orgExists } from '../services/directory-client';

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /referrals
// Create a new referral. Validates that both orgs exist in the directory.
// ---------------------------------------------------------------------------
router.post('/referrals', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as CreateReferralInput & { channel: OrgChannel };

  const { fromOrgId, toOrgId, channel, patient, request: referralRequest } = body;

  if (!fromOrgId || !toOrgId || !channel || !patient || !referralRequest) {
    res.status(400).json({
      error: 'Missing required fields: fromOrgId, toOrgId, channel, patient, request',
    });
    return;
  }

  const [fromExists, toExists] = await Promise.all([
    orgExists(fromOrgId),
    orgExists(toOrgId),
  ]);

  if (!fromExists) {
    res.status(422).json({ error: `fromOrgId not found in directory: ${fromOrgId}` });
    return;
  }
  if (!toExists) {
    res.status(422).json({ error: `toOrgId not found in directory: ${toOrgId}` });
    return;
  }

  const input: CreateReferralInput = {
    fromOrgId,
    toOrgId,
    channel,
    patient,
    request: referralRequest,
  };

  const referral = createReferral(input);
  res.status(201).json({ data: referral });
});

// ---------------------------------------------------------------------------
// GET /referrals
// List referrals with optional query-param filters.
// ---------------------------------------------------------------------------
router.get('/referrals', (req: Request, res: Response): void => {
  const { fromOrgId, toOrgId, status } = req.query as {
    fromOrgId?: string;
    toOrgId?: string;
    status?: ReferralStatus;
  };

  const referrals = listReferrals({
    ...(fromOrgId ? { fromOrgId } : {}),
    ...(toOrgId ? { toOrgId } : {}),
    ...(status ? { status } : {}),
  });

  res.json({ data: referrals });
});

// ---------------------------------------------------------------------------
// GET /referrals/:id
// Fetch a single referral by ID.
// ---------------------------------------------------------------------------
router.get('/referrals/:id', (req: Request, res: Response): void => {
  const referral = getReferral(req.params.id);
  if (!referral) {
    res.status(404).json({ error: `Referral not found: ${req.params.id}` });
    return;
  }
  res.json({ data: referral });
});

// ---------------------------------------------------------------------------
// PATCH /referrals/:id/status
// Advance the lifecycle status of a referral.
// ---------------------------------------------------------------------------
router.patch('/referrals/:id/status', (req: Request, res: Response): void => {
  const { status, note } = req.body as { status: ReferralStatus; note?: string };

  if (!status) {
    res.status(400).json({ error: 'Missing required field: status' });
    return;
  }

  const referral = updateStatus(req.params.id, status, note);
  if (!referral) {
    res.status(404).json({ error: `Referral not found: ${req.params.id}` });
    return;
  }

  res.json({ data: referral });
});

export default router;

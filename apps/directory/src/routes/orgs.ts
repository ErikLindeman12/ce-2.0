import { Router, Request, Response } from 'express';
import type { CreateOrgInput } from '@ce2/types';
import {
  getAllOrgs,
  getOrgById,
  getOrgBySlug,
  createOrg,
  updateOrg,
} from '../store/orgs';

const router: import('express').Router = Router();

router.get('/orgs', (req: Request, res: Response) => {
  let orgs = getAllOrgs();

  if (req.query.active !== undefined) {
    const activeFilter = req.query.active === 'true';
    orgs = orgs.filter((org) => org.active === activeFilter);
  }

  res.json({ data: orgs });
});

router.get('/orgs/slug/:slug', (req: Request, res: Response) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) {
    res.status(404).json({ error: 'Org not found' });
    return;
  }
  res.json({ data: org });
});

router.get('/orgs/:id', (req: Request, res: Response) => {
  const org = getOrgById(req.params.id);
  if (!org) {
    res.status(404).json({ error: 'Org not found' });
    return;
  }
  res.json({ data: org });
});

router.post('/orgs', (req: Request, res: Response) => {
  const { name, tenantSlug, endpointUrl, capabilities } = req.body as Partial<CreateOrgInput>;

  if (!name || !tenantSlug || !endpointUrl || !capabilities) {
    res.status(400).json({ error: 'Missing required fields: name, tenantSlug, endpointUrl, capabilities' });
    return;
  }

  const org = createOrg({
    name,
    tenantSlug,
    endpointUrl,
    capabilities,
    active: req.body.active ?? true,
  });

  res.status(201).json({ data: org });
});

router.put('/orgs/:id', (req: Request, res: Response) => {
  const org = updateOrg(req.params.id, req.body);
  if (!org) {
    res.status(404).json({ error: 'Org not found' });
    return;
  }
  res.json({ data: org });
});

export default router;

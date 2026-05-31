import { Router, Request, Response, type IRouter } from 'express';
import type {
  TokenIssueRequest,
  TokenValidateRequest,
  TokenValidateResponse,
} from '@ce2/types';
import { issueToken, validateToken } from '@ce2/auth';
import { orgExists } from '../services/directory-client';

const router: IRouter = Router();

/**
 * POST /tokens/issue
 *
 * Issues a short-lived cross-org JWT allowing requestingOrgId to call
 * a service hosted by targetOrgId.
 */
router.post('/tokens/issue', async (req: Request, res: Response) => {
  const body = req.body as TokenIssueRequest;

  const { requestingOrgId, targetOrgId } = body;

  if (!requestingOrgId || !targetOrgId) {
    res.status(400).json({ error: 'requestingOrgId and targetOrgId are required' });
    return;
  }

  // Validate both orgs exist in the directory.
  const [requestingExists, targetExists] = await Promise.all([
    orgExists(requestingOrgId),
    orgExists(targetOrgId),
  ]);

  if (!requestingExists) {
    res.status(400).json({ error: `Unknown org: ${requestingOrgId}` });
    return;
  }
  if (!targetExists) {
    res.status(400).json({ error: `Unknown org: ${targetOrgId}` });
    return;
  }

  try {
    const token = await issueToken(body);
    res.status(200).json({ data: token });
  } catch (err) {
    // issueToken is currently a stub — surface a clear 501 rather than 500.
    res.status(501).json({ error: 'Token signing not yet implemented' });
  }
});

/**
 * POST /tokens/validate
 *
 * Validates a cross-org JWT. Always returns 200; validation failures are
 * expressed in the response body ({ valid: false, error: ... }).
 */
router.post('/tokens/validate', async (req: Request, res: Response) => {
  const body = req.body as TokenValidateRequest;

  let result: TokenValidateResponse;
  try {
    result = await validateToken(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation failed';
    result = { valid: false, error: message };
  }

  res.status(200).json({ data: result });
});

export default router;

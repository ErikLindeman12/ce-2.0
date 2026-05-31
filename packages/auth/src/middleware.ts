import type { Request, Response, NextFunction } from 'express';
import type { CrossOrgTokenClaims } from '@ce2/types';
import { validateToken } from './token-validator';

declare global {
  namespace Express {
    interface Request {
      crossOrgClaims?: CrossOrgTokenClaims;
    }
  }
}

export async function requireCrossOrgAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const result = await validateToken({
      token,
      expectedAudience: req.hostname,
    });

    if (!result.valid || !result.claims) {
      res.status(401).json({ error: result.error ?? 'Invalid token' });
      return;
    }

    req.crossOrgClaims = result.claims;
    next();
  } catch {
    res.status(401).json({ error: 'Token validation failed' });
  }
}

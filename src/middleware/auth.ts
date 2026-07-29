import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;        // userId
  tenantId: string;
  email?: string;
  emailVerified?: boolean;
  role?: string;      // 'USER' | 'ADMIN' — absent on tokens issued before this field was added
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    if (!payload.tenantId) {
      res.status(401).json({ error: 'Token missing tenantId' });
      return;
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireVerified(req: Request, res: Response, next: NextFunction): void {
  if (!req.user.emailVerified) {
    res.status(403).json({ error: 'Email verification required. Please check your inbox and verify your email address.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

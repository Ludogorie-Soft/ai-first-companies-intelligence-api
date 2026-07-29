import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import { createAuditLog } from '../../services/auditLog';

const router = Router();

// GET /api/admin/users — all users with current-month usage
router.get('/users', requireAuth, requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const month = new Date().toISOString().slice(0, 7);

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        monthlyDomainLimit: true,
        createdAt: true,
        tenantId: true,
        monthlyUsage: {
          where: { month },
          select: { domainsUsed: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      monthlyDomainLimit: u.monthlyDomainLimit,
      createdAt: u.createdAt,
      tenantId: u.tenantId,
      domainsUsedThisMonth: u.monthlyUsage[0]?.domainsUsed ?? 0,
    })));
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/admin/users/:id — update role and/or monthlyDomainLimit
router.patch('/users/:id', requireAuth, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { role, monthlyDomainLimit } = req.body as {
    role?: string;
    monthlyDomainLimit?: number | null;
  };

  if (role !== undefined && !['USER', 'ADMIN'].includes(role)) {
    res.status(400).json({ error: 'role must be USER or ADMIN' });
    return;
  }

  if (
    monthlyDomainLimit !== undefined &&
    monthlyDomainLimit !== null &&
    (!Number.isInteger(monthlyDomainLimit) || monthlyDomainLimit < 0)
  ) {
    res.status(400).json({ error: 'monthlyDomainLimit must be a non-negative integer or null' });
    return;
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, monthlyDomainLimit: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (role === 'USER' && existing.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        res.status(400).json({ error: 'The system must always have at least one administrator.' });
        return;
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(role !== undefined ? { role: role as 'USER' | 'ADMIN' } : {}),
        ...(monthlyDomainLimit !== undefined ? { monthlyDomainLimit } : {}),
      },
      select: { id: true, email: true, role: true, monthlyDomainLimit: true },
    });

    const adminUserId = req.user.sub;

    if (role !== undefined && role !== existing.role) {
      await createAuditLog({
        adminUserId,
        targetUserId: id,
        action: 'ROLE_CHANGED',
        field: 'role',
        oldValue: existing.role,
        newValue: role,
      });
    }

    if (monthlyDomainLimit !== undefined && monthlyDomainLimit !== existing.monthlyDomainLimit) {
      const oldLimit = existing.monthlyDomainLimit;
      const newLimit = monthlyDomainLimit;

      let action: 'MONTHLY_LIMIT_ADDED' | 'MONTHLY_LIMIT_REMOVED' | 'MONTHLY_LIMIT_CHANGED';
      if (oldLimit === null) {
        action = 'MONTHLY_LIMIT_ADDED';
      } else if (newLimit === null) {
        action = 'MONTHLY_LIMIT_REMOVED';
      } else {
        action = 'MONTHLY_LIMIT_CHANGED';
      }

      await createAuditLog({
        adminUserId,
        targetUserId: id,
        action,
        field: 'monthlyDomainLimit',
        oldValue: oldLimit === null ? 'Unlimited' : String(oldLimit),
        newValue: newLimit === null ? 'Unlimited' : String(newLimit),
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('[admin/users/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/audit-log — paginated audit log with filters
router.get('/audit-log', requireAuth, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const { adminEmail, targetEmail, action, dateFrom, dateTo, order } = req.query as Record<string, string | undefined>;

  const where: Prisma.AuditLogWhereInput = {};

  if (adminEmail) {
    where.adminUser = { email: { contains: adminEmail, mode: 'insensitive' } };
  }
  if (targetEmail) {
    where.targetUser = { email: { contains: targetEmail, mode: 'insensitive' } };
  }
  if (action) {
    where.action = action;
  }
  if (dateFrom || dateTo) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (dateFrom) createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    where.createdAt = createdAt;
  }

  try {
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: order === 'asc' ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          action: true,
          field: true,
          oldValue: true,
          newValue: true,
          adminUser: { select: { id: true, email: true } },
          targetUser: { select: { id: true, email: true } },
        },
      }),
    ]);

    res.json({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[admin/audit-log]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

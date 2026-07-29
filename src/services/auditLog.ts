import { prisma } from '../lib/prisma';

export type AuditAction =
  | 'ROLE_CHANGED'
  | 'MONTHLY_LIMIT_CHANGED'
  | 'MONTHLY_LIMIT_REMOVED'
  | 'MONTHLY_LIMIT_ADDED';

interface CreateAuditLogParams {
  adminUserId: string;
  targetUserId: string;
  action: AuditAction;
  field: string;
  oldValue: string;
  newValue: string;
}

export async function createAuditLog(params: CreateAuditLogParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      action: params.action,
      field: params.field,
      oldValue: params.oldValue,
      newValue: params.newValue,
    },
  });
}

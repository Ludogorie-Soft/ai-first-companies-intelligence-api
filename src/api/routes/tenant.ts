import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';

const router = Router();

const PROFILE_SELECT = {
  name: true,
  website: true,
  contactPersonName: true,
  contactPersonTitle: true,
  contactPersonEmail: true,
  contactPersonPhone: true,
  aboutUs: true,
  productsServices: true,
  portfolio: true,
} as const;

/**
 * @openapi
 * /api/tenant/profile:
 *   get:
 *     summary: Get tenant profile (sender info for campaign emails)
 *     tags: [Tenant]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tenant profile
 */
router.get('/profile', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: PROFILE_SELECT,
  });

  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  res.json(tenant);
});

/**
 * @openapi
 * /api/tenant/profile:
 *   put:
 *     summary: Update tenant profile (sender info for campaign emails)
 *     tags: [Tenant]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               website:
 *                 type: string
 *               contactPersonName:
 *                 type: string
 *               contactPersonTitle:
 *                 type: string
 *               contactPersonEmail:
 *                 type: string
 *               contactPersonPhone:
 *                 type: string
 *               aboutUs:
 *                 type: string
 *               productsServices:
 *                 type: string
 *               portfolio:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated tenant profile
 */
router.put('/profile', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const {
    name, website,
    contactPersonName, contactPersonTitle,
    contactPersonEmail, contactPersonPhone,
    aboutUs, productsServices, portfolio,
  } = req.body;

  const tenant = await prisma.tenant.update({
    where: { id: req.user.tenantId },
    data: {
      ...(name               !== undefined ? { name }               : {}),
      ...(website            !== undefined ? { website }            : {}),
      ...(contactPersonName  !== undefined ? { contactPersonName }  : {}),
      ...(contactPersonTitle !== undefined ? { contactPersonTitle } : {}),
      ...(contactPersonEmail !== undefined ? { contactPersonEmail } : {}),
      ...(contactPersonPhone !== undefined ? { contactPersonPhone } : {}),
      ...(aboutUs            !== undefined ? { aboutUs }            : {}),
      ...(productsServices   !== undefined ? { productsServices }   : {}),
      ...(portfolio          !== undefined ? { portfolio }          : {}),
    },
    select: PROFILE_SELECT,
  });

  res.json(tenant);
});

export default router;

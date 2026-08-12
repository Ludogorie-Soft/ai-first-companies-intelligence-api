import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getQueue, enqueueDiscoverJob } from '../../lib/queue';
import { requireAuth, requireVerified } from '../../middleware/auth';
import { buildDiscoveryKey } from '../../services/discovery/discoveryKey';
import { parseEmailLanguage } from '../../lib/emailLanguage';

const router = Router();

/**
 * @openapi
 * /api/persona-searches:
 *   post:
 *     summary: Start a persona-based lead discovery search
 *     tags: [Persona]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [persona, location]
 *             properties:
 *               persona:
 *                 type: string
 *                 example: "детски градини"
 *               location:
 *                 type: string
 *                 example: "област Ловеч"
 *               keywords:
 *                 type: string
 *                 example: "частни"
 *               maxResults:
 *                 type: integer
 *                 default: 20
 *                 minimum: 5
 *                 maximum: 50
 *               emailLanguage:
 *                 type: string
 *                 enum: [bg, en, website]
 *                 default: bg
 *                 description: Language for Email Subject, Outreach Message, and Campaign Email
 *     responses:
 *       201:
 *         description: Search started, batch created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 message: { type: string }
 *       400:
 *         description: Validation error
 *       429:
 *         description: Weekly quota exceeded
 */
router.post('/', requireAuth, requireVerified, async (req: Request, res: Response): Promise<void> => {
  const { persona, location, keywords, maxResults: rawMax, force_recrawl, templateId: rawTemplateId, emailLanguage: rawEmailLanguage } = req.body as {
    persona?: string;
    location?: string;
    keywords?: string;
    maxResults?: number;
    force_recrawl?: boolean;
    templateId?: string;
    emailLanguage?: string;
  };
  const emailLanguage = parseEmailLanguage(rawEmailLanguage);

  if (!persona?.trim() || !location?.trim()) {
    res.status(400).json({ error: 'persona and location are required' });
    return;
  }

  const maxResults = Math.min(Math.max(parseInt(String(rawMax ?? 50), 10) || 50, 5), 60);
  const tenantId = req.user.tenantId;

  try {
    // Quota check against the requested maxResults
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (tenant.usageResetAt < oneWeekAgo) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { weeklyUsage: 0, usageResetAt: new Date() },
      });
      tenant.weeklyUsage = 0;
    }

    if (tenant.weeklyUsage + maxResults > tenant.weeklyQuota) {
      res.status(429).json({
        error: 'Weekly quota exceeded',
        quota: tenant.weeklyQuota,
        used: tenant.weeklyUsage,
        requested: maxResults,
      });
      return;
    }

    // Resolve templateId: explicit → default for tenant → null
    let resolvedTemplateId: string | null = null;
    if (rawTemplateId) {
      const tmpl = await prisma.emailTemplate.findFirst({
        where: { id: rawTemplateId, tenantId },
        select: { id: true },
      });
      resolvedTemplateId = tmpl?.id ?? null;
    } else {
      const defaultTmpl = await prisma.emailTemplate.findFirst({
        where: { tenantId, isDefault: true },
        select: { id: true },
      });
      resolvedTemplateId = defaultTmpl?.id ?? null;
    }

    const displayName = `${persona.trim()} – ${location.trim()}`;
    const discoveryKey = buildDiscoveryKey(persona.trim(), location.trim(), keywords?.trim());

    const batch = await prisma.crawlBatch.create({
      data: {
        tenantId,
        fileName: displayName,
        sourceType: 'PERSONA_SEARCH',
        searchQuery: {
          persona: persona.trim(),
          location: location.trim(),
          keywords: keywords?.trim() ?? '',
          maxResults,
          emailLanguage,
        },
        discoveryKey,
        status: 'PROCESSING',
        totalCompanies: 0,
        ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
      },
    });

    const queue = await getQueue();
    await enqueueDiscoverJob(
      {
        batchId: batch.id,
        tenantId,
        persona: persona.trim(),
        location: location.trim(),
        keywords: keywords?.trim(),
        maxResults,
        forceRecrawl: Boolean(force_recrawl),
        templateId: resolvedTemplateId ?? undefined,
        emailLanguage,
      },
      queue
    );

    res.status(201).json({ batchId: batch.id, message: 'Search started' });
  } catch (err) {
    console.error('[persona/create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

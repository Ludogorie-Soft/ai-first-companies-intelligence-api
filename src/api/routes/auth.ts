import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../lib/prisma';
import { sendConfirmationEmail } from '../../lib/email';

const router = Router();

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     summary: Register a new user and tenant
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, tenantName]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               tenantName:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered, JWT returned
 *       400:
 *         description: Validation error or email already taken
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const {
    email, password, tenantName,
    website, contactPersonName, contactPersonTitle, contactPersonPhone,
  } = req.body;

  if (!email || !password || !tenantName) {
    res.status(400).json({ error: 'email, password and tenantName are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(400).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const emailVerificationToken = uuidv4();

  const { user, tenant } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: tenantName,
        website:            website            || null,
        contactPersonName:  contactPersonName  || null,
        contactPersonTitle: contactPersonTitle || null,
        contactPersonEmail: email,
        contactPersonPhone: contactPersonPhone || null,
      },
    });
    const user = await tx.user.create({
      data: { email, passwordHash, tenantId: tenant.id, emailVerificationToken },
    });
    return { user, tenant };
  });

  // Send confirmation email (non-blocking — don't fail registration if email fails)
  sendConfirmationEmail(email, emailVerificationToken).catch((err) => {
    console.error('[auth/register] Failed to send confirmation email:', err.message);
  });

  const token = jwt.sign(
    { sub: user.id, tenantId: tenant.id, email: user.email, emailVerified: user.emailVerified, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  // In development (non-production + no SMTP configured), return the verification URL directly
  // so developers can verify without needing real email delivery.
  // This field is NEVER included when NODE_ENV=production, regardless of EMAIL_HOST.
  const isDevMode = process.env.NODE_ENV !== 'production' && !process.env.EMAIL_HOST;
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
  const devVerificationUrl = isDevMode
    ? `${appUrl}/api/auth/confirm-email?token=${emailVerificationToken}`
    : undefined;

  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, emailVerified: user.emailVerified, tenantId: tenant.id, role: user.role },
    ...(devVerificationUrl !== undefined ? { devVerificationUrl } : {}),
  });
});

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful, JWT returned
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { sub: user.id, tenantId: user.tenantId, email: user.email, emailVerified: user.emailVerified, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, email: user.email, emailVerified: user.emailVerified, tenantId: user.tenantId, role: user.role },
  });
});

/**
 * @openapi
 * /api/auth/confirm-email:
 *   get:
 *     summary: Confirm email address via token from email link
 *     tags: [Auth]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirects to dashboard with result
 */
router.get('/confirm-email', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (!token || typeof token !== 'string') {
    res.redirect(`${frontendUrl}/dashboard?error=invalid_token`);
    return;
  }

  try {
    const found = await prisma.user.findFirst({ where: { emailVerificationToken: token } });

    if (!found) {
      res.redirect(`${frontendUrl}/dashboard?error=invalid_token`);
      return;
    }

    const user = await prisma.user.update({
      where: { id: found.id },
      data: { emailVerified: true, emailVerificationToken: null },
    });

    // Issue a fresh JWT so the browser session immediately reflects emailVerified=true.
    // Without this the stored token (minted at register/login) would retain emailVerified:false
    // and requireVerified would block uploads until the user manually re-logged in.
    const freshToken = jwt.sign(
      { sub: user.id, tenantId: user.tenantId, email: user.email, emailVerified: true, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.redirect(`${frontendUrl}/dashboard?verified=true&token=${freshToken}`);
  } catch (err) {
    console.error('[auth/confirm-email]', err);
    res.redirect(`${frontendUrl}/dashboard?error=server_error`);
  }
});

export default router;

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from.trim() };
}

export function logBrevoConfig(): void {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey) {
    console.warn('[email] WARNING: BREVO_API_KEY is not set — email delivery disabled.');
    console.warn('[email]   Running in console (dev) mode. Set BREVO_API_KEY + EMAIL_FROM to enable.');
    return;
  }

  const maskedKey = `${apiKey.slice(0, 6)}***${apiKey.slice(-4)}`;
  console.log('[email] Brevo API enabled');
  console.log(`[email]   FROM=${from || '(not set)'}`);
  console.log(`[email]   API_KEY=${maskedKey}`);
}

export async function sendConfirmationEmail(email: string, token: string): Promise<void> {
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
  const confirmUrl = `${appUrl}/api/auth/confirm-email?token=${token}`;
  const from = process.env.EMAIL_FROM || 'noreply@companies-intelligence.local';
  const apiKey = process.env.BREVO_API_KEY;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
    <div style="background:#2563eb;padding:32px;text-align:center">
      <div style="font-size:32px">🏢</div>
      <h1 style="color:#fff;margin:8px 0 0;font-size:20px;font-weight:700">Companies Intelligence</h1>
    </div>
    <div style="padding:40px">
      <h2 style="color:#111827;font-size:18px;margin:0 0 16px">Confirm your email address</h2>
      <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 24px">
        Thanks for signing up! Click the button below to verify your email address and activate your account.
      </p>
      <a href="${confirmUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Confirm Email Address
      </a>
      <p style="color:#9ca3af;font-size:12px;margin:32px 0 0;line-height:1.6">
        If you didn't create an account, you can safely ignore this email.<br>
        This link expires in 24 hours.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="color:#9ca3af;font-size:12px;margin:0">
        Or copy this link into your browser:<br>
        <span style="color:#6b7280;word-break:break-all">${confirmUrl}</span>
      </p>
    </div>
  </div>
</body>
</html>`;

  if (!apiKey) {
    console.log('[email] DEV MODE — printing verification URL to console (BREVO_API_KEY not configured):');
    console.log(`[email]   To: ${email}`);
    console.log(`[email]   Confirm URL: ${confirmUrl}`);
    return;
  }

  console.log(`[email] sending verification email to ${email}`);

  const sender = parseSender(from);
  const payload = {
    sender,
    to: [{ email }],
    subject: 'Confirm your Companies Intelligence account',
    textContent: `Confirm your email address by visiting: ${confirmUrl}`,
    htmlContent: html,
  };

  let response: Response;
  try {
    response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const e = err as Error;
    console.error(`[email] verification email failed (network error): ${e.message}`);
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Brevo API error ${response.status}: ${body}`);
    console.error(`[email] verification email failed: ${err.message}`);
    throw err;
  }

  console.log(`[email] verification email sent`);
}

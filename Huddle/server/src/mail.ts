/**
 * Sending email. Huddle uses Resend's HTTP API (https://resend.com), because many hosts, Render's free tier among
 * them, block the ports ordinary SMTP needs. Set:
 *   RESEND_API_KEY   an API key from resend.com
 *   MAIL_FROM        the sender, e.g. "Huddle <no-reply@yourdomain.com>" (the domain must be verified in Resend)
 * Without them, email is switched off: the app says so where it matters, and in development the message is printed to
 * the server log so you can still see the code.
 */
const { RESEND_API_KEY, MAIL_FROM } = process.env;

export const mailEnabled = !!(RESEND_API_KEY && MAIL_FROM);

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!mailEnabled) {
    if (process.env.NODE_ENV !== "production") console.log(`[mail disabled] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Sending email failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Sending email failed", e);
    return false;
  }
}

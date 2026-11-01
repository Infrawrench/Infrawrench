import { env } from "cloudflare:workers";
import { AlertError, subscribe } from "@/lib/alerts";

/**
 * POST /api/views/<id>/subscribe `{ email, locale }`: start an email alert on
 * a view and send the confirmation email. Rate limited per IP, since each
 * call sends mail to an address the caller chose.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    locale?: unknown;
  } | null;
  if (typeof body?.email !== "string") {
    return Response.json({ error: "Email address is required" }, { status: 400 });
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  if (env.ALERT_LIMITER && !(await env.ALERT_LIMITER.limit({ key: ip })).success) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    await subscribe(id, body.email, typeof body.locale === "string" ? body.locale : "en");
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof AlertError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("subscribe failed", error);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

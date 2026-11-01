import { confirm, getAlert, summarize, unsubscribe } from "@/lib/alerts";

/**
 * GET /api/alerts/<id>: what the alert page shows (title, masked address,
 * status). POST `{ action: "confirm" | "unsubscribe" }` changes it. The id,
 * from the emailed link, is the only credential.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const alert = await getAlert((await params).id);
  if (!alert) return Response.json({ error: "No such alert" }, { status: 404 });
  return Response.json(await summarize(alert), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const alert = await getAlert((await params).id);
  if (!alert) return Response.json({ error: "No such alert" }, { status: 404 });
  const { action } = ((await request.json().catch(() => null)) ?? {}) as { action?: unknown };
  if (action === "confirm") await confirm(alert);
  else if (action === "unsubscribe") await unsubscribe(alert.id);
  else return Response.json({ error: "Unknown action" }, { status: 400 });
  return Response.json({ ok: true });
}

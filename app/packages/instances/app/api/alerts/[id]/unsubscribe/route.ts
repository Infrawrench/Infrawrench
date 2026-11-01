import { getAlert, unsubscribe } from "@/lib/alerts";

/**
 * POST /api/alerts/<id>/unsubscribe: RFC 8058 one-click unsubscribe, the
 * `List-Unsubscribe` target of every alert email. Mail clients POST here
 * without a page; people use the alert page instead.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const alert = await getAlert((await params).id);
  if (alert) await unsubscribe(alert.id);
  return new Response(null, { status: 204 });
}

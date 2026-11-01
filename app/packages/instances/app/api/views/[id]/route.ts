import { runView, loadView } from "@/lib/chat/views";
import { QueryError } from "@/lib/warehouse";

/** GET /api/views/<id>: a saved view with its data, re-queried (cached for a few minutes). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadView(id);
  if (!view) return Response.json({ error: "No such view" }, { status: 404 });
  try {
    return Response.json(await runView(view), {
      headers: { "cache-control": "public, max-age=300, stale-while-revalidate=1800" },
    });
  } catch (error) {
    if (error instanceof QueryError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }
}

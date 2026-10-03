import type { Context } from "hono";

/**
 * Read a request body that must be a JSON object. Discriminated on `ok` rather
 * than on the presence of an `error` key, because `{"error": "..."}` is a
 * perfectly legal request body and the sloppier shape would misread it as a
 * parse failure.
 */
export async function readObjectBody(req: {
  json: () => Promise<unknown>;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Request body must be an object" };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

/**
 * {@link readObjectBody} for handlers that want the 400 ready-made: on failure
 * `error` is the response to return and `body` is empty.
 */
export async function parseObjectBody(
  c: Context,
): Promise<{ body: Record<string, unknown>; error?: Response }> {
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return { body: {}, error: c.json({ error: parsed.error }, 400) };
  return { body: parsed.body };
}

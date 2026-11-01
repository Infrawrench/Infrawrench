import { env } from "cloudflare:workers";
import { runChat } from "@/lib/chat/agent";
import type { ChatEvent, ChatTurn } from "@/lib/chat/types";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";

/**
 * POST /api/chat: one turn of the instances chat. Takes the transcript the
 * browser keeps (`{ turns: ChatTurn[], locale }`) and streams `ChatEvent`s
 * back as NDJSON. Rate limited per IP (`CHAT_LIMITER`); the conversation is
 * not stored.
 */

/** Turns of history sent to the model; older ones are dropped. */
const MAX_TURNS = 24;
/** Characters per turn, and in total. */
const MAX_TURN_CHARS = 6_000;
const MAX_TOTAL_CHARS = 60_000;

function parseTurns(body: unknown): ChatTurn[] | null {
  const raw = (body as { turns?: unknown })?.turns;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: ChatTurn[] = [];
  for (const t of raw.slice(-MAX_TURNS)) {
    const role = (t as ChatTurn)?.role;
    const text = (t as ChatTurn)?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") return null;
    const views = Array.isArray((t as ChatTurn).views)
      ? (t as ChatTurn).views!.slice(0, 8).flatMap((v) =>
          typeof v?.id === "string" && typeof v.title === "string" && typeof v.sql === "string"
            ? [
                {
                  id: v.id.slice(0, 32),
                  kind: v.kind === "chart" ? ("chart" as const) : ("table" as const),
                  title: v.title.slice(0, 160),
                  sql: v.sql.slice(0, 4_000),
                },
              ]
            : [],
        )
      : undefined;
    turns.push({ role, text: text.slice(0, MAX_TURN_CHARS), ...(views ? { views } : {}) });
  }
  let total = 0;
  for (const t of turns)
    total += t.text.length + (t.views ?? []).reduce((n, v) => n + v.sql.length, 0);
  if (total > MAX_TOTAL_CHARS) return null;
  if (turns.at(-1)?.role !== "user" || !turns.at(-1)!.text.trim()) return null;
  return turns;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const turns = parseTurns(body);
  if (!turns) return Response.json({ error: "Bad request" }, { status: 400 });
  const rawLocale = (body as { locale?: unknown }).locale;
  const locale = typeof rawLocale === "string" && isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = env.CHAT_LIMITER
    ? await env.CHAT_LIMITER.limit({ key: ip })
    : { success: true };

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const emit = (event: ChatEvent) => {
    void writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  };

  const run = async () => {
    try {
      if (!success) {
        emit({ type: "error", code: "rate_limited", message: "rate_limited" });
        return;
      }
      await runChat(turns, locale, emit, request.signal);
    } catch (error) {
      console.error("chat failed", error);
      emit({ type: "error", code: "unavailable", message: "unavailable" });
    } finally {
      emit({ type: "done" });
      await writer.close().catch(() => {});
    }
  };
  void run();

  return new Response(stream.readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Stops proxies from buffering the stream.
      "x-accel-buffering": "no",
    },
  });
}

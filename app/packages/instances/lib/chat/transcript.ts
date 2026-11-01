import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ChatTurn } from "./types";

/** The browser's transcript as API messages: text only, with each shown view noted. */
export function toMessages(turns: ChatTurn[]): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [];
  for (const turn of turns) {
    const notes = (turn.views ?? []).map(
      (v) => `[Showed ${v.kind} "${v.title}" (view ${v.id}) from:\n${v.sql}]`,
    );
    const text = [turn.text.trim(), ...notes].filter(Boolean).join("\n\n");
    if (!text) continue;
    const last = messages.at(-1);
    // The API wants alternating roles; merge any repeats.
    if (last && last.role === turn.role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${text}`;
    } else {
      messages.push({ role: turn.role, content: text });
    }
  }
  // The API wants a user message first. A conversation opened from a shared
  // view starts with that view, which is context the follow-up refers to
  // ("which of these..."), so it moves into the first question rather than
  // being dropped.
  const opening: string[] = [];
  while (messages[0]?.role === "assistant") opening.push(String(messages.shift()!.content));
  const first = messages[0];
  if (opening.length && first && typeof first.content === "string") {
    first.content = `This conversation was opened from a shared view, already on screen:\n\n${opening.join("\n\n")}\n\n${first.content}`;
  }
  return messages;
}

import type {
  BetaContentBlockParam,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { HistoryTurn } from "./steps";

type Message = { role: BetaMessageParam["role"]; content: BetaContentBlockParam[] };

/**
 * The browser's transcript as API messages. An answer whose tool calls came
 * back (checked by `openHistory`) is replayed as those calls and their
 * results, then its text, so the model sees what it queried and what it got.
 * Any other answer is its text with each shown view noted by its SQL.
 *
 * Replayed answers carry no thinking blocks, which the API allows for turns
 * before the current one, and their text follows all of their tool calls
 * rather than sitting between them.
 */
export function toMessages(turns: HistoryTurn[]): BetaMessageParam[] {
  const messages: Message[] = [];
  // The API wants alternating roles; merge any repeats.
  const push = (role: Message["role"], blocks: BetaContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  // Answers before the first question (a shared view) are never replayed:
  // their tool results would end up first, where only a question can go.
  const firstQuestion = turns.findIndex((t) => t.role === "user");
  for (const [i, turn] of turns.entries()) {
    const replayed = i > firstQuestion && turn.role === "assistant" && !!turn.steps?.length;
    for (const calls of replayed ? turn.steps! : []) {
      push(
        "assistant",
        calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} })),
      );
      push(
        "user",
        calls.map((c) => ({
          type: "tool_result",
          tool_use_id: c.id,
          content: c.result,
          ...(c.isError ? { is_error: true } : {}),
        })),
      );
    }
    // A replayed answer's views are among its tool calls already.
    const notes = replayed
      ? []
      : (turn.views ?? []).map(
          (v) => `[Showed ${v.kind} "${v.title}" (view ${v.id}) from:\n${v.sql}]`,
        );
    const text = [turn.text.trim(), ...notes].filter(Boolean).join("\n\n");
    if (text) push(turn.role, [{ type: "text", text }]);
  }

  // The API wants a user message first. A conversation opened from a shared
  // view starts with that view, which is context the follow-up refers to
  // ("which of these..."), so it moves into the first question rather than
  // being dropped.
  const opening: string[] = [];
  while (messages[0]?.role === "assistant") {
    for (const block of messages.shift()!.content) {
      if (block.type === "text") opening.push(block.text);
    }
  }
  const first = messages[0];
  if (opening.length && first) {
    first.content.unshift({
      type: "text",
      text: `This conversation was opened from a shared view, already on screen:\n\n${opening.join("\n\n")}`,
    });
  }
  return messages;
}

import { describe, it, expect } from "vitest";
import type { ChatContentBlock } from "@infrawrench/ui";
import { toGeminiContents } from "../providers/gemini";
import { sanitizeForAnthropic } from "../providers/anthropic";

function user(content: ChatContentBlock[]) {
  return { role: "user" as const, content };
}
function assistant(content: ChatContentBlock[]) {
  return { role: "assistant" as const, content };
}

describe("toGeminiContents", () => {
  it("maps assistant to the model role and keeps user as user", () => {
    const contents = toGeminiContents({
      messages: [
        user([{ type: "text", text: "hi" }]),
        assistant([{ type: "text", text: "hello" }]),
      ],
    });

    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
    expect(contents[0]?.parts?.[0]).toEqual({ text: "hi" });
  });

  it("carries the thought signature back on tool_use so Gemini 3 accepts the replay", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([
          {
            type: "tool_use",
            id: "call-1",
            name: "list_resources",
            input: { a: 1 },
            signature: "sig-abc",
            provider: "gemini",
          },
        ]),
      ],
    });

    const part = contents[0]?.parts?.[0];
    expect(part?.functionCall).toEqual({ id: "call-1", name: "list_resources", args: { a: 1 } });
    expect(part?.thoughtSignature).toBe("sig-abc");
  });

  it("omits thoughtSignature entirely when the block has none", () => {
    const contents = toGeminiContents({
      messages: [assistant([{ type: "tool_use", id: "call-1", name: "t", input: {} }])],
    });

    expect(contents[0]?.parts?.[0]).not.toHaveProperty("thoughtSignature");
  });

  it("resolves the function name for a tool_result from the earlier tool_use", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([{ type: "tool_use", id: "call-7", name: "sql_query", input: {} }]),
        user([
          {
            type: "tool_result",
            tool_use_id: "call-7",
            content: [{ type: "text", text: "3 rows" }],
          },
        ]),
      ],
    });

    expect(contents[1]?.parts?.[0]?.functionResponse).toEqual({
      id: "call-7",
      name: "sql_query",
      response: { output: "3 rows" },
    });
  });

  it("marks failed tool results with error rather than output", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([{ type: "tool_use", id: "c", name: "ssh_exec", input: {} }]),
        user([
          {
            type: "tool_result",
            tool_use_id: "c",
            content: [{ type: "text", text: "boom" }],
            is_error: true,
          },
        ]),
      ],
    });

    expect(contents[1]?.parts?.[0]?.functionResponse?.response).toEqual({ error: "boom" });
  });

  it("falls back to a placeholder name when the tool_use is no longer in history", () => {
    const contents = toGeminiContents({
      messages: [user([{ type: "tool_result", tool_use_id: "orphan", content: "x" }])],
    });

    expect(contents[0]?.parts?.[0]?.functionResponse?.name).toBe("unknown");
  });

  it("drops unsigned thinking blocks, which the API rejects on replay", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([
          { type: "thinking", thinking: "unsigned", signature: "" },
          { type: "text", text: "answer" },
        ]),
      ],
    });

    expect(contents[0]?.parts).toEqual([{ text: "answer" }]);
  });

  it("keeps signed thinking blocks as thought parts", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([
          { type: "thinking", thinking: "reasoned", signature: "sig", provider: "gemini" },
        ]),
      ],
    });

    expect(contents[0]?.parts?.[0]).toEqual({
      text: "reasoned",
      thought: true,
      thoughtSignature: "sig",
    });
  });

  it("skips messages that convert to no parts at all", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([{ type: "thinking", thinking: "x", signature: "" }]),
        user([{ type: "text", text: "still here" }]),
      ],
    });

    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe("user");
  });

  // A conversation switched from Claude to Gemini mid-thread carries Anthropic
  // signatures in its history; replaying them would be rejected.
  it("never replays an Anthropic thought signature to Gemini", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([
          { type: "thinking", thinking: "claude reasoning", signature: "anthropic-sig" },
          { type: "text", text: "answer" },
        ]),
      ],
    });

    expect(contents[0]?.parts).toEqual([{ text: "answer" }]);
  });

  // Gemini 3 can sign a plain text part with no thought part present at all;
  // the signature has to survive the round trip.
  it("round-trips a thought signature carried on a text part", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([{ type: "text", text: "OK", signature: "sig-text", provider: "gemini" }]),
      ],
    });

    expect(contents[0]?.parts?.[0]).toEqual({ text: "OK", thoughtSignature: "sig-text" });
  });

  it("does not replay a text signature that came from another provider", () => {
    const contents = toGeminiContents({
      messages: [assistant([{ type: "text", text: "OK", signature: "not-gemini" }])],
    });

    expect(contents[0]?.parts?.[0]).toEqual({ text: "OK" });
  });

  it("keeps a Claude tool_use but without its signature", () => {
    const contents = toGeminiContents({
      messages: [
        assistant([
          { type: "tool_use", id: "t1", name: "list_resources", input: {}, signature: "anthropic" },
        ]),
      ],
    });

    expect(contents[0]?.parts?.[0]?.functionCall?.id).toBe("t1");
    expect(contents[0]?.parts?.[0]).not.toHaveProperty("thoughtSignature");
  });
});

describe("sanitizeForAnthropic", () => {
  it("drops Gemini thinking blocks whose signature Anthropic cannot verify", () => {
    const out = sanitizeForAnthropic([
      { type: "thinking", thinking: "gemini reasoning", signature: "g-sig", provider: "gemini" },
      { type: "text", text: "answer" },
    ]);

    expect(out).toEqual([{ type: "text", text: "answer" }]);
  });

  it("keeps Anthropic thinking blocks, including legacy ones with no provider tag", () => {
    const out = sanitizeForAnthropic([
      { type: "thinking", thinking: "a", signature: "s1" },
      { type: "thinking", thinking: "b", signature: "s2", provider: "anthropic" },
    ]);

    expect(out).toHaveLength(2);
    expect(out.every((b) => b.type === "thinking")).toBe(true);
  });

  it("strips the Gemini signature off text blocks, which Anthropic would reject", () => {
    const out = sanitizeForAnthropic([
      { type: "text", text: "hello", signature: "g-sig", provider: "gemini" },
    ]);

    expect(out).toEqual([{ type: "text", text: "hello" }]);
  });

  it("strips provider-specific fields from tool_use without dropping the block", () => {
    // Dropping it would orphan the paired tool_result and break the request.
    const out = sanitizeForAnthropic([
      {
        type: "tool_use",
        id: "t1",
        name: "sql_query",
        input: { q: 1 },
        signature: "g",
        provider: "gemini",
      },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ]);

    expect(out[0]).toEqual({ type: "tool_use", id: "t1", name: "sql_query", input: { q: 1 } });
    expect(out[1]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "ok" });
  });
});

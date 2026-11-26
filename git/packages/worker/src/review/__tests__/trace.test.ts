import { describe, expect, it } from "vitest";
import { MASK } from "../masking";
import { TRACE_LIMITS, byteLength, excerpt, prepareAgent, prepareTraceEntries } from "../trace";

/** Assembled here so no line of this file is a token's shape. */
const token = `ghp_${"aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0z".repeat(2).slice(0, 36)}`;

describe("excerpt", () => {
  it("keeps what fits", () => {
    expect(excerpt("short", 100, 10)).toBe("short");
  });

  it("keeps the start and the end and says what is gone", () => {
    const text = `START${"x".repeat(10_000)}END`;
    const cut = excerpt(text, 1024, 256);
    expect(byteLength(cut)).toBeLessThanOrEqual(1024);
    expect(cut.startsWith("START")).toBe(true);
    expect(cut.endsWith("END")).toBe(true);
    const omitted = Number(/\[\.\.\. (\d+) bytes left out \.\.\.\]/.exec(cut)![1]);
    // What is kept and what is said to be gone add up to what was given.
    const [head, tail] = cut.split(/\n\[\.\.\. \d+ bytes left out \.\.\.\]\n/) as [string, string];
    expect(byteLength(head) + byteLength(tail) + omitted).toBe(byteLength(text));
  });

  it("never cuts inside a character", () => {
    const text = "é".repeat(5000) + "日本語".repeat(2000) + "🙂".repeat(1000);
    for (const [limit, head] of [
      [1001, 301],
      [1002, 302],
      [1003, 303],
      [2048, 511],
    ] as const) {
      const cut = excerpt(text, limit, head);
      expect(cut).not.toContain("�");
      expect(byteLength(cut)).toBeLessThanOrEqual(limit);
    }
  });
});

describe("prepareTraceEntries", () => {
  it("masks every string an entry carries", () => {
    const prepared = prepareTraceEntries([
      {
        kind: "evidence",
        body: `pushed with ${token}`,
        anchors: [{ path: `secrets/${token}.txt`, startLine: 3 }],
        evidence: {
          command: `gh auth login --with-token ${token}`,
          exitCode: 1,
          output: `Authorization: Bearer ${token}`,
          ciRunId: "run-1",
          url: `https://${token}@example.test/x`,
        },
      },
    ]);
    expect(Array.isArray(prepared)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain(token);
    expect(prepared).toEqual([
      {
        kind: "evidence",
        body: `pushed with ${MASK}`,
        anchors: [{ path: `secrets/${MASK}.txt`, startLine: 3, endLine: null }],
        evidence: {
          command: `gh auth login --with-token ${MASK}`,
          exitCode: 1,
          output: `Authorization: Bearer ${MASK}`,
          ciRunId: "run-1",
          url: `https://${MASK}@example.test/x`,
        },
      },
    ]);
  });

  it("masks before it cuts, so a secret at the cut does not survive in part", () => {
    // The token straddles where the head of the excerpt ends.
    const output = `${"x".repeat(TRACE_LIMITS.outputHeadBytes - 10)}${token}${"y".repeat(40_000)}`;
    const prepared = prepareTraceEntries([{ kind: "evidence", body: "b", evidence: { output } }]);
    if (!Array.isArray(prepared)) throw new Error("refused");
    const kept = prepared[0]!.evidence!.output!;
    expect(byteLength(kept)).toBeLessThanOrEqual(TRACE_LIMITS.outputBytes);
    expect(kept).not.toContain(token.slice(0, 12));
    expect(kept).not.toContain(token.slice(-12));
  });

  it("holds a command to its limit", () => {
    const prepared = prepareTraceEntries([
      { kind: "evidence", body: "b", evidence: { command: "echo ".repeat(2000) } },
    ]);
    if (!Array.isArray(prepared)) throw new Error("refused");
    expect(byteLength(prepared[0]!.evidence!.command!)).toBeLessThanOrEqual(
      TRACE_LIMITS.commandBytes,
    );
  });

  it("refuses a body past its limit, by bytes, naming the entry", () => {
    const fits = "a".repeat(TRACE_LIMITS.bodyBytes);
    expect(Array.isArray(prepareTraceEntries([{ kind: "note", body: fits }]))).toBe(true);
    expect(
      prepareTraceEntries([
        { kind: "note", body: "ok" },
        { kind: "note", body: "é".repeat(TRACE_LIMITS.bodyBytes / 2 + 1) },
      ]),
    ).toEqual({ reason: "body_too_large", index: 1 });
  });

  it("defaults what an entry left out", () => {
    expect(prepareTraceEntries([{ kind: "step", body: "did it", evidence: null }])).toEqual([
      { kind: "step", body: "did it", anchors: [], evidence: null },
    ]);
    expect(prepareTraceEntries([{ kind: "evidence", body: "ran", evidence: {} }])).toEqual([
      {
        kind: "evidence",
        body: "ran",
        anchors: [],
        evidence: { command: null, exitCode: null, output: null, ciRunId: null, url: null },
      },
    ]);
  });
});

describe("prepareAgent", () => {
  it("masks what an agent calls itself", () => {
    expect(prepareAgent(undefined)).toBeNull();
    expect(prepareAgent({ kind: "mcp", name: "Codex" })).toEqual({
      kind: "mcp",
      name: "Codex",
      sessionRef: null,
    });
    expect(
      JSON.stringify(prepareAgent({ kind: "mcp", name: token, sessionRef: token })),
    ).not.toContain(token);
  });
});

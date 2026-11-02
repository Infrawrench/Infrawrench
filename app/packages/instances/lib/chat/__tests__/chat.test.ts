import { describe, expect, it } from "vitest";
import {
  formatCell,
  inferFormat,
  numericFilter,
  parseDateTime,
  toCsv,
  viewPlatform,
  type Units,
} from "../format";
import { checkAgainstResult, parseViewSpec } from "../spec";
import { QueryError, checkSql } from "../sql";
import { formatCatalog } from "../catalog-text";
import { MAX_HISTORY_STEP_CHARS, openHistory, openStep, signStep } from "../steps";
import { toMessages } from "../transcript";
import type { ToolCallRecord } from "../types";

/** A message's text blocks, joined. */
const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n\n");

describe("checkSql", () => {
  it("passes reads and strips a trailing semicolon", () => {
    expect(checkSql("SELECT 1;")).toBe("SELECT 1");
    expect(checkSql("-- note\nWITH x AS (SELECT 1) SELECT * FROM x")).toContain("WITH");
    expect(checkSql("DESCRIBE TABLE prices")).toBe("DESCRIBE TABLE prices");
  });

  it("refuses writes, several statements, FORMAT and SETTINGS", () => {
    expect(() => checkSql("DROP TABLE prices")).toThrow(QueryError);
    expect(() => checkSql("SELECT 1; DROP TABLE prices")).toThrow(/one statement/);
    expect(() => checkSql("SELECT 1 FORMAT CSV")).toThrow(/FORMAT/);
    expect(() => checkSql("SELECT 1 SETTINGS max_threads = 1")).toThrow(/SETTINGS/);
  });

  it("does not mistake a semicolon in a string for a second statement", () => {
    expect(checkSql("SELECT 'a;b'")).toBe("SELECT 'a;b'");
  });
});

describe("parseViewSpec", () => {
  it("builds a table spec, dropping unknown formats", () => {
    expect(
      parseViewSpec("table", {
        title: " Cheap ARM ",
        sql: "SELECT 1",
        columns: [{ name: "a", format: "usd_hour" }, { name: "b", format: "nope" }, {}],
        sort_by: "a",
        sort_desc: true,
      }),
    ).toEqual({
      kind: "table",
      title: "Cheap ARM",
      sql: "SELECT 1",
      columns: [{ name: "a", format: "usd_hour" }, { name: "b" }],
      sort: { column: "a", direction: "desc" },
    });
  });

  it("says what is missing", () => {
    expect(
      parseViewSpec("chart", { title: "t", sql: "SELECT 1", chart_type: "pie", x: "a", y: "b" }),
    ).toMatch(/chart_type/);
    expect(parseViewSpec("table", { sql: "SELECT 1" })).toMatch(/title/);
  });

  it("checks named columns against the result", () => {
    const spec = parseViewSpec("chart", {
      title: "t",
      sql: "s",
      chart_type: "bar",
      x: "name",
      y: "price",
    });
    expect(typeof spec).toBe("object");
    expect(checkAgainstResult(spec as never, ["name", "cost"])).toMatch(/`price`/);
    expect(checkAgainstResult(spec as never, ["name", "price"])).toBeNull();
  });
});

describe("formatting", () => {
  const units: Units = {
    perHour: (p) => `${p}/hr`,
    perMonth: (p) => `${p}/mo`,
    gib: (a) => `${a} GiB`,
    yes: "Yes",
    no: "No",
  };

  it("infers formats from names and types", () => {
    expect(inferFormat("hourly_usd", "Float64")).toBe("usd_hour");
    expect(inferFormat("monthly_usd", "Float64")).toBe("usd_month");
    expect(inferFormat("memory_gib", "Nullable(Float64)")).toBe("gib");
    expect(inferFormat("instance_type", "String")).toBe("instance");
    expect(inferFormat("valid_from", "DateTime")).toBe("datetime");
    expect(inferFormat("vcpu", "Nullable(Float64)")).toBe("number");
  });

  it("formats small prices with enough digits", () => {
    expect(formatCell(0.0042, "usd_hour", "en", units)).toBe("$0.0042/hr");
    expect(formatCell(29.784, "usd_month", "en", units)).toBe("$29.78/mo");
    expect(formatCell("2026-10-29 17:56:34", "date", "en", units)).toBe("Oct 29, 2026");
  });

  it("parses numeric filters", () => {
    expect(numericFilter(">4")?.(5)).toBe(true);
    expect(numericFilter("<=0.05")?.(0.06)).toBe(false);
    expect(numericFilter("2..8")?.(8)).toBe(true);
    expect(numericFilter("graviton")).toBeNull();
  });

  it("reads ClickHouse DateTimes as UTC", () => {
    expect(parseDateTime("1970-01-02 00:00:00")).toBe(86400);
  });

  it("finds the platform a query is about", () => {
    expect(viewPlatform("SELECT * FROM prices WHERE platform = 'rds' AND current")).toBe("rds");
    expect(viewPlatform("SELECT * FROM prices WHERE platform IN ('rds','ec2')")).toBe("ec2");
  });

  it("writes CSV with quoting", () => {
    const cols = [
      { index: 0, name: "a", label: "A", format: "text" as const, numeric: false },
      { index: 1, name: "b", label: "B", format: "number" as const, numeric: true },
    ];
    expect(
      toCsv(cols, [
        ["x,y", 1],
        [null, 2],
      ]),
    ).toBe('A,B\n"x,y",1\n,2');
  });
});

describe("toMessages", () => {
  const view = {
    id: "abc123",
    kind: "table" as const,
    title: "x86 EC2 instances",
    sql: "SELECT instance_type FROM instance_types",
  };

  it("keeps a shared view that opens the conversation, inside the first question", () => {
    const messages = toMessages([
      { role: "assistant", text: "", views: [view] },
      { role: "user", text: "Which of these has the most vCPUs?" },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    const text = textOf(messages[0]!.content);
    expect(text).toContain('[Showed table "x86 EC2 instances" (view abc123)');
    expect(text).toContain("SELECT instance_type FROM instance_types");
    expect(text.endsWith("Which of these has the most vCPUs?")).toBe(true);
  });

  it("alternates roles, merging repeats", () => {
    const messages = toMessages([
      { role: "user", text: "a" },
      { role: "user", text: "b" },
      { role: "assistant", text: "c", views: [view] },
      { role: "user", text: "d" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(messages[0]!.content)).toBe("a\n\nb");
    expect(textOf(messages[1]!.content)).toContain("view abc123");
  });

  it("replays an answer's tool calls and results before its text, without view notes", () => {
    const calls: ToolCallRecord[] = [
      { id: "toolu_1", name: "run_sql", input: { sql: "SELECT 1" }, result: "x UInt8\n[1]" },
      {
        id: "toolu_2",
        name: "run_sql",
        input: { sql: "SELECT bad" },
        result: "nope",
        isError: true,
      },
    ];
    const messages = toMessages([
      { role: "user", text: "q1" },
      { role: "assistant", text: "It is 1.", views: [view], steps: [calls] },
      { role: "user", text: "q2" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[1]!.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "run_sql", input: { sql: "SELECT 1" } },
      { type: "tool_use", id: "toolu_2", name: "run_sql", input: { sql: "SELECT bad" } },
    ]);
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "x UInt8\n[1]" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "nope", is_error: true },
    ]);
    expect(textOf(messages[3]!.content)).toBe("It is 1.");
  });

  it("puts a question after tool results when the answer had no text", () => {
    const messages = toMessages([
      { role: "user", text: "q1" },
      {
        role: "assistant",
        text: "",
        steps: [[{ id: "toolu_1", name: "run_sql", input: {}, result: "r" }]],
      },
      { role: "user", text: "q2" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((messages[2]!.content as { type: string }[]).map((b) => b.type)).toEqual([
      "tool_result",
      "text",
    ]);
  });

  it("never replays tool calls ahead of the first question", () => {
    const messages = toMessages([
      {
        role: "assistant",
        text: "",
        views: [view],
        steps: [[{ id: "toolu_1", name: "show_table", input: {}, result: "r" }]],
      },
      { role: "user", text: "Which?" },
    ]);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0]!.content)).toContain("view abc123");
  });
});

describe("tool steps", () => {
  const secret = "test-secret";
  const calls: ToolCallRecord[] = [
    { id: "toolu_1", name: "run_sql", input: { sql: "SELECT 1" }, result: "x UInt8\n[1]" },
  ];

  it("opens what it signed and refuses anything else", async () => {
    const step = await signStep(secret, calls);
    expect(await openStep(secret, step)).toEqual(calls);
    expect(await openStep("other-secret", step)).toBeNull();
    const forged = { ...step, data: step.data.replace("[1]", "[2]") };
    expect(await openStep(secret, forged)).toBeNull();
    expect(await openStep(secret, { ...step, sig: "not base64!" })).toBeNull();
  });

  it("keeps the newest answers' steps whole, within the budget", async () => {
    const step = await signStep(secret, calls);
    const big = await signStep(secret, [
      { ...calls[0]!, result: "x".repeat(MAX_HISTORY_STEP_CHARS) },
    ]);
    const forged = { ...step, sig: big.sig };
    const turns = await openHistory(secret, [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1", steps: [step] },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2", steps: [step, forged] },
      { role: "user", text: "q3" },
      { role: "assistant", text: "a3", steps: [big] },
      { role: "user", text: "q4" },
    ]);
    // a3 is over the budget and a2 has a step that fails the check: neither
    // keeps any; a1 is within the newest three answers and keeps its own.
    expect(turns[5]!.steps).toBeUndefined();
    expect(turns[3]!.steps).toBeUndefined();
    expect(turns[1]!.steps).toEqual([calls]);
  });

  it("looks back only STEP_HISTORY_ANSWERS answers", async () => {
    const step = await signStep(secret, calls);
    const turns = await openHistory(
      secret,
      [1, 2, 3, 4].flatMap((n) => [
        { role: "user" as const, text: `q${n}` },
        { role: "assistant" as const, text: `a${n}`, steps: [step] },
      ]),
    );
    expect(turns.map((t) => !!t.steps)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
  });
});

describe("formatCatalog", () => {
  it("lists each platform's values as SQL literals, then region codes by cloud", () => {
    const text = formatCatalog(
      {
        columns: [
          { name: "platform", type: "LowCardinality(String)" },
          { name: "operating_system__values", type: "Array(String)" },
          { name: "operating_system__count", type: "UInt64" },
          { name: "pricing__values", type: "Array(String)" },
          { name: "pricing__count", type: "UInt64" },
        ],
        rows: [
          ["azure", '["Linux"]', 1, '["on_demand"]', 1],
          ["ec2", JSON.stringify(["Linux", "Windows", "Bob's OS"]), 30, '["on_demand"]', 1],
        ],
        truncated: false,
      },
      {
        columns: [],
        rows: [["azure", "variant['priority']", '["Regular","Spot"]', 2]],
        truncated: false,
      },
      {
        columns: [],
        rows: [
          ["azure", "eastus", "US East"],
          ["aws", "us-east-1", "US East (N. Virginia)"],
        ],
        truncated: false,
      },
    );
    const lines = text.split("\n");
    // ec2 before azure, pricing before operating_system, the variant map last.
    expect(lines[1]).toBe(
      "- ec2: pricing: 'on_demand'; operating_system: 'Linux', 'Windows', 'Bob\\'s OS', and 27 more",
    );
    expect(lines[2]).toBe(
      "- azure: pricing: 'on_demand'; operating_system: 'Linux'; variant['priority']: 'Regular', 'Spot'",
    );
    expect(text).toContain("- AWS: us-east-1 (US East (N. Virginia))\n- Azure: eastus (US East)");
  });
});

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { env, waitUntil } from "cloudflare:workers";
import { query, QueryError } from "../warehouse";
import { SYSTEM_PROMPT, languageBlock } from "./prompt";
import type { ChatEvent, ChatTurn, QueryResult } from "./types";
import { toMessages } from "./transcript";
import { checkAgainstResult, parseViewSpec, runView, saveView, storeResult } from "./views";

/**
 * One chat turn: Claude (through Cloudflare AI Gateway, called with the AI
 * binding) with three tools over
 * the pricing warehouse, streamed to the browser as `ChatEvent`s.
 *
 * The browser keeps the transcript (`ChatTurn[]`: text plus the views each
 * answer showed) and sends it with every message; nothing about the
 * conversation is stored here. Within a turn the loop is the usual manual
 * tool loop, appending each response's content unchanged.
 */

export const MODEL = "claude-sonnet-5-5";
/** Tool round trips per turn before the answer is cut short. */
const MAX_STEPS = 10;
/** Characters of query output a tool result shows the model. */
const RESULT_CHARS = 12_000;

const COLUMN_FORMAT_SCHEMA = {
  type: "string",
  enum: [
    "text",
    "number",
    "usd_hour",
    "usd_month",
    "usd",
    "gib",
    "percent",
    "datetime",
    "date",
    "instance",
    "bool",
  ],
} as const;

const TOOLS: BetaTool[] = [
  {
    name: "run_sql",
    description:
      "Run one read-only ClickHouse query against the pricing database and see up to 100 rows. Use it to explore and to answer questions with a number or two. The person does not see these results.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "One SELECT (or WITH, DESCRIBE, SHOW) statement, no FORMAT or SETTINGS.",
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "show_table",
    description:
      "Show the person an interactive table from a query (up to 2,000 rows; they can sort, filter, pick columns, download CSV, copy a share link and subscribe to email alerts when the result changes). Returns the first rows.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, in the reply language." },
        sql: {
          type: "string",
          description: "The query; its columns become the table's, in order.",
        },
        columns: {
          type: "array",
          description: "Optional label and format per result column.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Result column name." },
              label: { type: "string" },
              format: COLUMN_FORMAT_SCHEMA,
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        sort_by: { type: "string", description: "Column the table opens sorted by." },
        sort_desc: { type: "boolean" },
        watch: {
          type: "boolean",
          description:
            "True when the person asked to be notified of changes: opens the email alert form under the table.",
        },
      },
      required: ["title", "sql"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "show_chart",
    description:
      "Show the person a chart from a query (up to 1,000 rows). `bar`: one bar per row, x the label column and y the value, sorted as the query orders them. `line`: y over time, x a DateTime column, optionally split by series. Returns the first rows.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sql: { type: "string" },
        chart_type: { type: "string", enum: ["bar", "line"] },
        x: { type: "string", description: "Result column for the bar labels or the time axis." },
        y: { type: "string", description: "Result column for the values." },
        series: {
          type: "string",
          description: "Line charts: result column that splits rows into lines.",
        },
        value_format: COLUMN_FORMAT_SCHEMA,
      },
      required: ["title", "sql", "chart_type", "x", "y"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

/** The first rows of a result as compact text for the model. */
function resultText(result: QueryResult, limit: number): string {
  const header = result.columns.map((c) => `${c.name} ${c.type}`).join(" | ");
  const lines = [header];
  let used = header.length;
  let shown = 0;
  for (const row of result.rows.slice(0, limit)) {
    const line = JSON.stringify(row);
    if (used + line.length > RESULT_CHARS) break;
    lines.push(line);
    used += line.length;
    shown++;
  }
  const total = result.truncated ? `more than ${result.rows.length}` : String(result.rows.length);
  lines.push(`(${total} rows${shown < result.rows.length ? `, first ${shown} shown` : ""})`);
  return lines.join("\n");
}

/** Request headers the binding forwards to Anthropic. */
const FORWARDED_HEADERS = ["anthropic-version", "anthropic-beta"];

/**
 * The SDK's transport, swapped for the Workers AI binding: each Messages
 * request goes to `env.AI.run("anthropic/<model>")` through the AI Gateway
 * named by `AI_GATEWAY_ID`, which bills it to the account (Unified Billing),
 * so the Worker holds no Anthropic key and no gateway token. The body and
 * the response (including the event stream) stay in Anthropic's own format,
 * so the SDK parses them as if it had called the API itself.
 */
function bindingFetch(gatewayId: string): typeof fetch {
  const send = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    const extraHeaders: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = headers.get(name);
      if (value) extraHeaders[name] = value;
    }
    // Third-party models fall to the binding's untyped overload, which does
    // not know that `returnRawResponse` makes the result a Response.
    // The gateway's catalog spells versions with a dot: anthropic/claude-sonnet-5.5.
    const model = `anthropic/${String(body["model"]).replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
    const response: unknown = await env.AI.run(
      model,
      { ...body, model },
      {
        gateway: { id: gatewayId },
        returnRawResponse: true,
        extraHeaders,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
    );
    return response as Response;
  };
  return send as typeof fetch;
}

function client(): Anthropic {
  // Local development can skip the binding and call the API (or a gateway
  // URL) directly with a key: set AI_GATEWAY_URL and ANTHROPIC_API_KEY in
  // .dev.vars.
  const directUrl = env.AI_GATEWAY_URL;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (directUrl && apiKey) {
    return new Anthropic({ apiKey, baseURL: directUrl, maxRetries: 1 });
  }
  // The SDK insists on a key; the binding never sends it.
  return new Anthropic({
    apiKey: "unused",
    maxRetries: 1,
    fetch: bindingFetch(env.AI_GATEWAY_ID || "instances"),
  });
}

export async function runChat(
  turns: ChatTurn[],
  locale: string,
  emit: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const anthropic = client();
  const messages = toMessages(turns);
  if (messages.at(-1)?.role !== "user") throw new Error("The last message must be the person's.");

  let wroteText = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    emit({ type: "status", status: "thinking" });
    // One moving breakpoint on the newest block caches the turn so far for
    // the next step (the system prompt holds another; the limit is four).
    for (const m of messages) {
      if (typeof m.content === "string") continue;
      for (const block of m.content) delete (block as { cache_control?: unknown }).cache_control;
    }
    const last = messages.at(-1)!;
    if (typeof last.content !== "string" && last.content.length > 0) {
      const block = last.content.at(-1) as BetaContentBlockParam & { cache_control?: unknown };
      block.cache_control = { type: "ephemeral" };
    }
    const stream = anthropic.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // No server-side refusal `fallbacks`: AI Gateway's catalog endpoint
        // rejects the field ("Extra inputs are not permitted").
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: languageBlock(locale) },
        ],
        tools: TOOLS,
        messages,
      },
      { signal },
    );
    let stepText = false;
    stream.on("text", (text) => {
      // Text from an earlier step of this turn ends a paragraph.
      if (!stepText && wroteText) emit({ type: "text", text: "\n\n" });
      stepText = wroteText = true;
      emit({ type: "text", text });
    });

    let message: BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      // Eager input streaming hands over tool input the API did not
      // validate; JSON that will not parse at all is worth one retry.
      if (error instanceof Anthropic.APIError || step >= 2) throw error;
      continue;
    }
    console.log(
      JSON.stringify({
        chat: "usage",
        step,
        stop: message.stop_reason,
        model: message.model,
        input: message.usage.input_tokens,
        cacheRead: message.usage.cache_read_input_tokens,
        output: message.usage.output_tokens,
      }),
    );

    if (message.stop_reason === "refusal") {
      emit({ type: "error", code: "refused", message: "refused" });
      return;
    }
    const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    // A tool call cut off by max_tokens can still parse; never run it.
    if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
      emit({ type: "error", code: "unavailable", message: "truncated" });
      return;
    }
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) return;

    messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] });
    const results = await Promise.all(toolUses.map((use) => runTool(use, emit)));
    messages.push({ role: "user", content: results });
  }
  emit({ type: "text", text: "\n\n…" });
}

async function runTool(
  use: BetaToolUseBlock,
  emit: (event: ChatEvent) => void,
): Promise<BetaToolResultBlockParam> {
  const done = (content: string, isError = false): BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  const input = (use.input ?? {}) as Record<string, unknown>;
  try {
    if (use.name === "run_sql") {
      if (typeof input["sql"] !== "string") return done("`sql` must be a string.", true);
      emit({ type: "status", status: "query", sql: input["sql"] });
      return done(resultText(await query(input["sql"], { maxRows: 100 }), 100));
    }
    if (use.name === "show_table" || use.name === "show_chart") {
      const spec = parseViewSpec(use.name === "show_table" ? "table" : "chart", input);
      if (typeof spec === "string") return done(spec, true);
      emit({ type: "status", status: "query", sql: spec.sql });
      // Saved before it runs, so the id is in hand; an unused one is only a
      // small KV value.
      const view = await saveView(spec);
      const data = await runView(view);
      const problem = checkAgainstResult(
        spec,
        data.result.columns.map((c) => c.name),
      );
      if (problem) return done(problem, true);
      if (data.result.rows.length === 0) {
        return done(
          "The query returned no rows, so nothing was shown. Check the filters (run_sql helps) and try again.",
          true,
        );
      }
      // Cached, so its share link opens without waiting on the warehouse.
      waitUntil(storeResult(data));
      emit({ type: "view", data, watch: use.name === "show_table" && input["watch"] === true });
      return done(
        `Shown to the person as ${spec.kind} "${spec.title}" (view ${view.id}).\n${resultText(data.result, 20)}`,
      );
    }
    return done(`Unknown tool ${use.name}.`, true);
  } catch (error) {
    if (error instanceof QueryError) return done(`Query failed: ${error.message}`, true);
    throw error;
  }
}

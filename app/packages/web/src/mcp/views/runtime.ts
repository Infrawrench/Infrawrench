/**
 * The view side of MCP Apps (https://modelcontextprotocol.io/extensions/apps),
 * bundled into every view's HTML by `scripts/generate-mcp-views.ts`. A view
 * runs in the MCP client's sandboxed frame and talks to its host over
 * `postMessage` JSON-RPC: it initialises, is handed the tool call's input and
 * result, says how tall it is, and can call tools on this server, open links
 * and suggest a message.
 *
 * Hand-rolled rather than `@modelcontextprotocol/ext-apps`' `App`: with its
 * dependencies that is ~400 KB in every view, for the half-dozen messages
 * these views use.
 */
import { VIEW_CSS } from "./style";

/** The MCP Apps protocol version these views speak. */
const PROTOCOL_VERSION = "2026-01-26";

/** A tool's answer, as MCP sends it. */
export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
}

export interface ViewHandlers {
  /** The arguments the tool was called with. */
  input?(args: Record<string, unknown>): void;
  /** What the tool answered. */
  result(result: ToolResult): void;
}

export interface ViewHost {
  /** Calls a tool on this server, as the view. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Asks the host to open a web address. */
  openLink(url: string): void;
  /** Suggests a message from the person to the model. */
  suggest(text: string): void;
}

interface Message {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Starts a view: styles the page, follows the host's theme, keeps the host
 * told of its height, and hands the call's input and result to `handlers`.
 */
export function startView(name: string, handlers: ViewHandlers): ViewHost {
  const style = document.createElement("style");
  style.textContent = VIEW_CSS;
  document.head.append(style);

  let next = 1;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const post = (message: Message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      post({ id, method, params });
    });
  const notify = (method: string, params: Record<string, unknown> = {}) => post({ method, params });

  const applyContext = (context: HostContext | undefined) => {
    if (!context) return;
    if (context.theme) document.documentElement.dataset.theme = context.theme;
    for (const [key, value] of Object.entries(context.styles?.variables ?? {})) {
      if (value) document.documentElement.style.setProperty(key, value);
    }
  };

  window.addEventListener("message", (event: MessageEvent<Message>) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    if (message.method === undefined && typeof message.id === "number") {
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "The host refused"));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "ui/notifications/tool-input":
        handlers.input?.(isRecord(params.arguments) ? params.arguments : {});
        return;
      case "ui/notifications/tool-result":
        handlers.result(params);
        return;
      case "ui/notifications/host-context-changed":
        applyContext(params);
        return;
    }
    // Requests from the host: answer the ones every view must, refuse the rest.
    if (message.id === undefined) return;
    if (message.method === "ping" || message.method === "ui/resource-teardown") {
      post({ id: message.id, result: {} });
    } else {
      post({ id: message.id, error: { message: `${message.method} isn't supported` } });
    }
  });

  void request("ui/initialize", {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name, version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((result) => {
    applyContext(isRecord(result) && isRecord(result.hostContext) ? result.hostContext : undefined);
    notify("ui/notifications/initialized");
  });

  let height = 0;
  new ResizeObserver(() => {
    const now = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (now === height) return;
    height = now;
    notify("ui/notifications/size-changed", { height });
  }).observe(document.documentElement);

  return {
    async callTool(tool, args) {
      const result = await request("tools/call", { name: tool, arguments: args });
      return isRecord(result) ? result : { isError: true };
    },
    openLink(url) {
      void request("ui/open-link", { url }).catch(() => {});
    },
    suggest(text) {
      void request("ui/message", { role: "user", content: [{ type: "text", text }] }).catch(
        () => {},
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON a tool answered with. Registry tools answer in text (`ok()`), so
 * that is read when there is no `structuredContent`.
 */
export function resultJson(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The text of a tool's answer, for showing an error as the tool said it. */
export function resultText(result: ToolResult): string {
  return (result.content ?? []).flatMap((c) => (c.text ? [c.text] : [])).join("\n");
}

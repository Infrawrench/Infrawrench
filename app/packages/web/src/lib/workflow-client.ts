/**
 * Browser-side WorkflowClient for the web app — talks to the org-scoped
 * `/api/org/:orgId/workflows` routes over fetch (session cookie auth).
 */
import type {
  DebugSession,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // ignore
    }
    throw new Error(`Request failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
}

export function createWebWorkflowClient(orgId: string): WorkflowClient {
  const base = `/api/org/${orgId}/workflows`;
  const opts = (method: string, body?: unknown): RequestInit => ({
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  /**
   * Debug run over the websocket: the browser owns breakpoints + stepping, the
   * server blocks before each instrumented line and resumes on `workflow:continue`.
   */
  async function runDebug(
    id: string,
    debug: DebugSession,
  ): Promise<{ runId: string; result: WorkflowRunRow }> {
    const { token } = await fetch(`/api/org/${orgId}/ws-token`, opts("POST")).then((r) =>
      json<{ token: string }>(r),
    );
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
    );
    let stepping = false;
    let settled = false;
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
        try {
          ws.close();
        } catch {
          // already closing
        }
      };
      const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

      debug.resume = () => {
        debug.onResumed?.();
        send({ type: "workflow:continue" });
      };
      debug.step = () => {
        stepping = true;
        debug.onResumed?.();
        send({ type: "workflow:continue" });
      };
      debug.stop = () => send({ type: "workflow:stop" });

      ws.onopen = () => send({ type: "workflow:run", workflowId: id });
      ws.onerror = () => finish(() => reject(new Error("Workflow connection failed")));
      ws.onclose = () => finish(() => reject(new Error("Workflow connection closed")));
      ws.onmessage = (ev) => {
        let m: {
          type: string;
          line?: number;
          entry?: unknown;
          spec?: { message?: string; defaultValue?: string };
          runId?: string;
          result?: unknown;
          message?: string;
        };
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (m.type) {
          case "workflow:line": {
            const line = m.line ?? 0;
            debug.onLine?.(line);
            if (debug.breakpoints.has(line) || stepping) {
              stepping = false;
              debug.onPaused?.(line); // user drives resume/step/stop -> continue
            } else {
              send({ type: "workflow:continue" });
            }
            break;
          }
          case "workflow:log":
            debug.onLog?.(m.entry as Parameters<NonNullable<DebugSession["onLog"]>>[0]);
            break;
          case "workflow:prompt": {
            const value =
              typeof window !== "undefined"
                ? window.prompt(m.spec?.message ?? "Input", m.spec?.defaultValue)
                : null;
            send({ type: "workflow:prompt:response", value });
            break;
          }
          case "workflow:result":
            finish(() => resolve({ runId: m.runId ?? "", result: m.result as WorkflowRunRow }));
            break;
          case "workflow:error":
            finish(() => reject(new Error(m.message ?? "Workflow run failed")));
            break;
        }
      };
    });
  }

  return {
    list: () => fetch(base, opts("GET")).then((r) => json<WorkflowSummary[]>(r)),
    create: (b: WorkflowSaveBody) =>
      fetch(base, opts("POST", b)).then((r) => json<WorkflowSummary>(r)),
    update: (id: string, b: WorkflowSaveBody) =>
      fetch(`${base}/${id}`, opts("PUT", b)).then((r) => json<WorkflowSummary>(r)),
    remove: (id: string) =>
      fetch(`${base}/${id}`, opts("DELETE"))
        .then((r) => json<{ ok: boolean }>(r))
        .then(() => undefined),
    getTypings: (id: string) =>
      fetch(`${base}/${id}/typings`, opts("GET"))
        .then((r) => json<{ dts: string }>(r))
        .then((d) => d.dts),
    run: (id: string, debug?: DebugSession) =>
      debug
        ? runDebug(id, debug)
        : fetch(`${base}/${id}/run`, opts("POST")).then((r) =>
            json<{ runId: string; result: WorkflowRunRow }>(r),
          ),
    listRuns: (id: string) =>
      fetch(`${base}/${id}/runs`, opts("GET")).then((r) => json<WorkflowRunRow[]>(r)),
    listMetrics: (id: string) =>
      fetch(`${base}/${id}/metrics`, opts("GET")).then((r) => json<WorkflowMetricRow[]>(r)),
  };
}

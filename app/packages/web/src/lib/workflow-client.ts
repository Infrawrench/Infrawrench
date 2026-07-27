/**
 * Browser-side WorkflowClient for the web app — talks to the org-scoped
 * `/api/org/:orgId/workflows` routes over fetch (session cookie auth).
 */
import type {
  DebugSession,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";
import { jsonInit, jsonOrThrow } from "./cookie-json";

export function createWebWorkflowClient(orgId: string): WorkflowClient {
  const base = `/api/org/${orgId}/workflows`;

  /**
   * Debug run over the websocket: the browser owns breakpoints + stepping, the
   * server blocks before each instrumented line and resumes on `workflow:continue`.
   */
  async function runDebug(
    id: string,
    debug: DebugSession,
  ): Promise<{ runId: string; result: WorkflowRunResult }> {
    const { token } = await fetch(`/api/org/${orgId}/ws-token`, jsonInit("POST")).then((r) =>
      jsonOrThrow<{ token: string }>(r),
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
            finish(() => resolve({ runId: m.runId ?? "", result: m.result as WorkflowRunResult }));
            break;
          case "workflow:error":
            finish(() => reject(new Error(m.message ?? "Workflow run failed")));
            break;
        }
      };
    });
  }

  return {
    list: () => fetch(base, jsonInit("GET")).then((r) => jsonOrThrow<WorkflowSummary[]>(r)),
    create: (b: WorkflowSaveBody) =>
      fetch(base, jsonInit("POST", b)).then((r) => jsonOrThrow<WorkflowSummary>(r)),
    update: (id: string, b: WorkflowSaveBody) =>
      fetch(`${base}/${id}`, jsonInit("PUT", b)).then((r) => jsonOrThrow<WorkflowSummary>(r)),
    remove: (id: string) =>
      fetch(`${base}/${id}`, jsonInit("DELETE"))
        .then((r) => jsonOrThrow<{ ok: boolean }>(r))
        .then(() => undefined),
    getTypings: (id: string) =>
      fetch(`${base}/${id}/typings`, jsonInit("GET"))
        .then((r) => jsonOrThrow<{ dts: string }>(r))
        .then((d) => d.dts),
    run: (id: string, debug?: DebugSession) =>
      debug
        ? runDebug(id, debug)
        : fetch(`${base}/${id}/run`, jsonInit("POST")).then((r) =>
            jsonOrThrow<{ runId: string; result: WorkflowRunResult }>(r),
          ),
    listRuns: (id: string) =>
      fetch(`${base}/${id}/runs`, jsonInit("GET")).then((r) => jsonOrThrow<WorkflowRunRow[]>(r)),
    listMetrics: (id: string) =>
      fetch(`${base}/${id}/metrics`, jsonInit("GET")).then((r) =>
        jsonOrThrow<WorkflowMetricRow[]>(r),
      ),
  };
}

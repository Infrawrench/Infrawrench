/**
 * Browser-side WorkflowClient for the web app — talks to the org-scoped
 * `/api/org/:orgId/workflows` routes over fetch (session cookie auth).
 */
import type {
  DebugSession,
  PromptSpec,
  WorkflowApprovalRow,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSecretSummary,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";
import { requestWorkflowPrompt } from "@infrawrench/ui/workflows/prompt-bridge";
import { jsonInit, jsonOrThrow } from "./cookie-json";

export function createWebWorkflowClient(orgId: string): WorkflowClient {
  const base = `/api/org/${orgId}/workflows`;
  const secretsBase = `/api/org/${orgId}/workflow-secrets`;
  const workflowBody = (body: WorkflowSaveBody) => {
    const { assignedSecretIds, ...rest } = body;
    return assignedSecretIds === undefined ? rest : { ...rest, secretIds: assignedSecretIds };
  };

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
          spec?: PromptSpec;
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
            // A real modal, not `window.prompt`: the browser's built-in is a
            // single-line string box that discards `kind` and `options`, so a
            // select would have rendered as a free-text field with no options.
            void requestWorkflowPrompt(m.spec ?? { message: "Input" }).then((value) => {
              send({ type: "workflow:prompt:response", value });
            });
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
      fetch(base, jsonInit("POST", workflowBody(b))).then((r) => jsonOrThrow<WorkflowSummary>(r)),
    update: (id: string, b: WorkflowSaveBody) =>
      fetch(`${base}/${id}`, jsonInit("PUT", workflowBody(b))).then((r) =>
        jsonOrThrow<WorkflowSummary>(r),
      ),
    remove: (id: string) =>
      fetch(`${base}/${id}`, jsonInit("DELETE"))
        .then((r) => jsonOrThrow<{ ok: boolean }>(r))
        .then(() => undefined),
    getTypings: (id: string, opts?: { enrich?: boolean }) =>
      fetch(`${base}/${id}/typings${opts?.enrich ? "?enrich=1" : ""}`, jsonInit("GET"))
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
    getAssignedSecrets: (id: string) =>
      fetch(`${base}/${id}/secrets`, jsonInit("GET"))
        .then((r) => jsonOrThrow<{ secretIds: string[]; secrets: WorkflowSecretSummary[] }>(r))
        .then(({ secretIds, secrets }) => ({ assignedSecretIds: secretIds, secrets })),
    listSecrets: () =>
      fetch(secretsBase, jsonInit("GET")).then((r) => jsonOrThrow<WorkflowSecretSummary[]>(r)),
    upsertSecret: async ({ id, name, value }) => {
      let secret: WorkflowSecretSummary;
      if (id) {
        secret = await fetch(
          `${secretsBase}/${encodeURIComponent(id)}`,
          jsonInit("PATCH", { name }),
        ).then((r) => jsonOrThrow<WorkflowSecretSummary>(r));
      } else {
        secret = await fetch(secretsBase, jsonInit("POST", { name })).then((r) =>
          jsonOrThrow<WorkflowSecretSummary>(r),
        );
      }
      return fetch(
        `${secretsBase}/${encodeURIComponent(secret.id)}/value`,
        jsonInit("PUT", { value }),
      ).then((r) => jsonOrThrow<WorkflowSecretSummary>(r));
    },
    deleteSecret: (id: string) =>
      fetch(`${secretsBase}/${encodeURIComponent(id)}`, jsonInit("DELETE"))
        .then((r) => jsonOrThrow<{ ok: boolean }>(r))
        .then(() => undefined),
    listPendingApprovals: (workflowId: string) =>
      fetch(
        `/api/org/${orgId}/workflow-approvals?status=pending&workflowId=${encodeURIComponent(workflowId)}`,
        jsonInit("GET"),
      ).then((r) => jsonOrThrow<WorkflowApprovalRow[]>(r)),
    decideApproval: (approvalId: string, decision: "approve" | "deny") =>
      fetch(
        `/api/org/${orgId}/workflow-approvals/${encodeURIComponent(approvalId)}/${decision}`,
        jsonInit("POST"),
      ).then((r) => jsonOrThrow<WorkflowApprovalRow>(r)),
  };
}

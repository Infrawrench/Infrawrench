import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_CANVAS_LIMITS,
  diffCostCanvasSpecs,
  normalizeCostCanvasName,
  type CostCanvas,
  type CostCanvasInput,
  type CostCanvasRunResult,
  type CostCanvasSpec,
  type CostGraphConfig,
} from "@infrawrench/client-core";
import { ShareDialog, type ShareTarget } from "../sharing/ShareDialog.js";
import { ConversationView } from "../chat/ConversationView.js";
import { CostGraphConfigModal } from "../cost/CostGraphConfigModal.js";
import { Modal } from "../components/Modal.js";
import { ArrowIcon } from "../components/icons/ChromeIcons.js";
import type { CostsPanelDashboard } from "../cost/types.js";
import { DeliverySchedulesSection } from "../delivery/DeliverySchedulesSection.js";
import type { DeliveryScheduleInput, DeliverySchedulesClient } from "../delivery/types.js";
import { CostCanvasView } from "./CostCanvasView.js";
import type { CostCanvasesClient } from "./types.js";

export interface CostCanvasesPanelProps {
  client: CostCanvasesClient;
  /** Which canvas to show; absent renders the list. Owned by the host (URL + tab). */
  canvasId?: string | undefined;
  onSelectCanvas?: ((canvasId: string | undefined) => void) | undefined;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}

function toInput(canvas: CostCanvas, spec: CostCanvasSpec = canvas.spec): CostCanvasInput {
  return {
    name: canvas.name,
    ...(canvas.description ? { description: canvas.description } : {}),
    spec,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Canvases: reports built by describing them.
 *
 * The list starts a canvas from a sentence; the detail page renders the
 * canvas next to the conversation that builds it. The agent writes the spec
 * through `write_cost_canvas`; an edit to a canvas with content arrives as an
 * approval in the chat with its block diff, and this page can preview the
 * proposed canvas before the user approves it. Refresh re-runs the saved
 * queries and never calls the model.
 */
export function CostCanvasesPanel({
  client,
  canvasId,
  onSelectCanvas,
  onOpenDashboard,
}: CostCanvasesPanelProps) {
  const gt = useGT();
  const [canvases, setCanvases] = useState<CostCanvas[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCanvases(await client.listCanvases());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (canvasId) {
    return (
      <CanvasDetail
        key={canvasId}
        client={client}
        canvasId={canvasId}
        onBack={() => {
          onSelectCanvas?.(undefined);
          void refresh();
        }}
        onDeleted={() => {
          onSelectCanvas?.(undefined);
          void refresh();
        }}
        onOpenDashboard={onOpenDashboard}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {gt("Couldn’t load canvases: {error}", { error })}{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              {gt("Retry")}
            </button>
          </div>
        )}
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Canvases")}</h2>
          <p className="text-xs text-on-surface-faint mt-0.5">
            {gt(
              "Describe a report and the assistant builds it from your cost data and connected tools. Canvases re-run their queries, so they stay current.",
            )}
          </p>
        </div>
        {client.draftCanvas && client.chat && (
          <NewCanvasComposer
            client={client}
            onCreated={(canvas) => {
              void refresh();
              onSelectCanvas?.(canvas.id);
            }}
          />
        )}
        <CanvasList canvases={canvases} onOpen={(c) => onSelectCanvas?.(c.id)} />
      </div>
    </div>
  );
}

function NewCanvasComposer({
  client,
  onCreated,
}: {
  client: CostCanvasesClient;
  onCreated: (canvas: CostCanvas) => void;
}) {
  const gt = useGT();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const examples = [
    gt("Monthly AI spend by team for the last 6 months, with cost per active user"),
    gt("This month's spend so far, the month-end forecast, and our budgets"),
    gt("Top services by spend over the last 30 days, with any anomalies"),
  ];

  async function create() {
    const text = prompt.trim();
    if (!text || busy || !client.draftCanvas) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await client.draftCanvas({ prompt: text }));
    } catch (e: unknown) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface-raised p-4 flex flex-col gap-3">
      <label className="text-xs font-medium text-on-surface-muted" htmlFor="canvas-prompt">
        {gt("What should the report show?")}
      </label>
      <textarea
        id="canvas-prompt"
        value={prompt}
        maxLength={COST_CANVAS_LIMITS.maxPromptLength}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void create();
          }
        }}
        rows={3}
        placeholder={gt("e.g. Monthly AI spend by team for the last 6 months")}
        className="bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
      />
      <div className="flex flex-wrap gap-2">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setPrompt(ex)}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-on-surface-muted hover:text-on-surface hover:border-border-strong"
          >
            {ex}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy || prompt.trim().length === 0}
          onClick={() => void create()}
          className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg"
        >
          {busy ? gt("Starting…") : gt("Build canvas")}
        </button>
      </div>
    </section>
  );
}

function CanvasList({
  canvases,
  onOpen,
}: {
  canvases: CostCanvas[] | null;
  onOpen: (canvas: CostCanvas) => void;
}) {
  const gt = useGT();
  if (canvases === null) {
    return (
      <p role="status" className="text-sm text-on-surface-faint">
        {gt("Loading canvases…")}
      </p>
    );
  }
  if (canvases.length === 0) {
    return <p className="text-sm text-on-surface-faint">{gt("No canvases yet.")}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {canvases.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onOpen(c)}
            className="w-full text-left rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-border-strong"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-on-surface">{c.name}</span>
              <span className="shrink-0 text-[11px] text-on-surface-faint">
                {gt("{count} blocks", { count: c.spec.blocks.length })}
                {c.placements.length > 0
                  ? ` · ${gt("on {count} dashboard(s)", { count: c.placements.length })}`
                  : ""}
              </span>
            </div>
            {(c.description || c.prompt) && (
              <p className="truncate text-xs text-on-surface-faint mt-0.5">
                {c.description || c.prompt}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

interface Proposal {
  pendingId: string;
  name: string;
  spec: CostCanvasSpec;
  summary: string | null;
}

function CanvasDetail({
  client,
  canvasId,
  onBack,
  onDeleted,
  onOpenDashboard,
}: {
  client: CostCanvasesClient;
  canvasId: string;
  onBack: () => void;
  onDeleted: () => void;
  onOpenDashboard?: ((dashboardId: string) => void) | undefined;
}) {
  const gt = useGT();
  const [canvas, setCanvas] = useState<CostCanvas | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [result, setResult] = useState<CostCanvasRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<CostCanvasRunResult | null>(null);
  const [editingChart, setEditingChart] = useState<number | null>(null);
  const [placing, setPlacing] = useState(false);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const canWrite = Boolean(client.updateCanvas);
  const canPlace = Boolean(
    client.listDashboards && client.addCanvasToDashboard && client.removeCanvasPlacement,
  );
  const lastUpdated = useRef<string | null>(null);

  const loadCanvas = useCallback(async () => {
    try {
      const next = await client.getCanvas(canvasId);
      setCanvas(next);
      setNotFound(false);
      setConversationId((cur) => cur ?? next.conversationId);
      return next;
    } catch (e: unknown) {
      const msg = errorText(e);
      if (/not found|404/i.test(msg)) setNotFound(true);
      else setError(msg);
      return null;
    }
  }, [client, canvasId]);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setResult(await client.runCanvas(canvasId, { includeChartData: false }));
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  }, [client, canvasId]);

  useEffect(() => {
    void loadCanvas().then((c) => {
      if (!c) return;
      // A canvas still waiting for its first spec opens with the chat, where
      // the agent is building it.
      if (c.spec.blocks.length === 0 && c.conversationId) setChatOpen(true);
    });
  }, [loadCanvas]);

  // Re-run whenever the saved spec changes (an approved edit, a manual edit).
  useEffect(() => {
    if (!canvas) return;
    if (lastUpdated.current === canvas.updatedAt) return;
    lastUpdated.current = canvas.updatedAt;
    void run();
  }, [canvas, run]);

  const findProposal = useCallback(async () => {
    if (!client.chat || !conversationId) return;
    try {
      const data = await client.chat.getConversation(conversationId);
      const pending = data.pendingActions.find(
        (p) =>
          p.status === "pending" &&
          p.toolName === "write_cost_canvas" &&
          p.toolInput["canvasId"] === canvasId,
      );
      if (!pending) {
        setProposal(null);
        setPreviewing(false);
        return;
      }
      const spec = pending.toolInput["spec"] as CostCanvasSpec | undefined;
      if (!spec || !Array.isArray(spec.blocks)) return;
      setProposal({
        pendingId: pending.id,
        name: typeof pending.toolInput["name"] === "string" ? pending.toolInput["name"] : "",
        spec,
        summary: pending.summary ?? null,
      });
    } catch {
      // The banner is a convenience; the approval card in the chat is the source of truth.
    }
  }, [client, conversationId, canvasId]);

  const onChatActivity = useCallback(() => {
    void loadCanvas();
    void findProposal();
  }, [loadCanvas, findProposal]);

  useEffect(() => {
    void findProposal();
  }, [findProposal]);

  useEffect(() => {
    if (!previewing || !proposal || !client.previewCanvas) {
      setPreviewResult(null);
      return;
    }
    let cancelled = false;
    client
      .previewCanvas(proposal.spec, proposal.name)
      .then((r) => {
        if (!cancelled) setPreviewResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [previewing, proposal, client]);

  const changedBlockIds = useMemo(() => {
    if (!proposal || !canvas) return undefined;
    return new Set(
      diffCostCanvasSpecs(canvas.spec, proposal.spec)
        .filter((c) => c.type !== "removed")
        .map((c) => c.blockId),
    );
  }, [proposal, canvas]);

  async function openChat() {
    if (conversationId) {
      setChatOpen((v) => !v);
      return;
    }
    if (!client.ensureConversation) return;
    try {
      setConversationId(await client.ensureConversation(canvasId));
      setChatOpen(true);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  async function saveSpec(spec: CostCanvasSpec) {
    if (!canvas || !client.updateCanvas) return;
    try {
      setCanvas(await client.updateCanvas(canvas.id, toInput(canvas, spec)));
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  async function rename() {
    if (!canvas || !client.updateCanvas) return;
    const raw = window.prompt(gt("Rename canvas"), canvas.name);
    if (raw === null) return;
    const name = normalizeCostCanvasName(raw);
    if (!name) return;
    try {
      setCanvas(await client.updateCanvas(canvas.id, { ...toInput(canvas), name }));
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  async function remove() {
    if (!canvas || !client.deleteCanvas) return;
    const where =
      canvas.placements.length > 0
        ? gt("\n\nIts card will also be removed from {names}.", {
            names: canvas.placements.map((p) => p.dashboardName).join(", "),
          })
        : "";
    if (!window.confirm(gt('Delete the canvas "{name}"?{where}', { name: canvas.name, where }))) {
      return;
    }
    try {
      await client.deleteCanvas(canvas.id);
      onDeleted();
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }

  async function downloadPdf() {
    if (!canvas || !client.downloadCanvasPdf) return;
    setPdfBusy(true);
    try {
      await client.downloadCanvasPdf(canvas.id, canvas.name);
    } catch (e: unknown) {
      setError(gt("Couldn't export the canvas as a PDF: {error}", { error: errorText(e) }));
    } finally {
      setPdfBusy(false);
    }
  }

  const delivery = useMemo(() => bindDeliveryClient(client, canvasId), [client, canvasId]);

  if (notFound) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-on-surface-faint">
        {gt("This canvas was deleted or is not shared with you.")}
        <button type="button" onClick={onBack} className="underline">
          {gt("All canvases")}
        </button>
      </div>
    );
  }

  const shownSpec = previewing && proposal ? proposal.spec : canvas?.spec;
  const shownResult = previewing && proposal ? previewResult : result;
  const action = "hover:text-on-surface-secondary underline disabled:opacity-50";

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                onClick={onBack}
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary underline"
              >
                <span className="inline-flex items-center gap-1">
                  <ArrowIcon direction="left" size={12} />
                  {gt("All canvases")}
                </span>
              </button>
              <h2 className="mt-1 truncate text-sm font-semibold text-on-surface">
                {canvas?.name ?? gt("Loading…")}
              </h2>
              {canvas?.description && (
                <p className="truncate text-xs text-on-surface-faint mt-0.5">
                  {canvas.description}
                </p>
              )}
              {result && (
                <p className="text-[11px] text-on-surface-faint mt-0.5">
                  {gt("Refreshed {when}", { when: new Date(result.ranAt).toLocaleString() })}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs text-on-surface-faint">
              <button
                type="button"
                disabled={running}
                onClick={() => void run()}
                className={action}
              >
                {running ? gt("Refreshing…") : gt("Refresh")}
              </button>
              {client.chat && (conversationId || client.ensureConversation) && (
                <button type="button" onClick={() => void openChat()} className={action}>
                  {chatOpen ? gt("Hide assistant") : gt("Edit with AI")}
                </button>
              )}
              {client.downloadCanvasPdf && (
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void downloadPdf()}
                  className={action}
                >
                  {pdfBusy ? gt("Preparing PDF…") : gt("Download PDF")}
                </button>
              )}
              {client.sharing && canvas && (
                <button
                  type="button"
                  onClick={() =>
                    setSharing({
                      objectType: "cost_canvas",
                      objectId: canvas.id,
                      name: canvas.name,
                    })
                  }
                  className={action}
                >
                  {gt("Share")}
                </button>
              )}
              {canPlace && (
                <button type="button" onClick={() => setPlacing(true)} className={action}>
                  {gt("Dashboards")}
                </button>
              )}
              {canWrite && (
                <button type="button" onClick={() => void rename()} className={action}>
                  {gt("Rename")}
                </button>
              )}
              {client.deleteCanvas && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="hover:text-danger underline"
                >
                  {gt("Delete")}
                </button>
              )}
            </div>
          </div>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          {proposal && (
            <div className="rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-xs flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-on-surface">
                  {gt(
                    "The assistant proposed changes to this canvas. Approve or reject them in the chat.",
                  )}
                </span>
                {client.previewCanvas && (
                  <button
                    type="button"
                    onClick={() => setPreviewing((v) => !v)}
                    className="shrink-0 underline text-on-surface-secondary"
                  >
                    {previewing ? gt("Show current") : gt("Preview proposed")}
                  </button>
                )}
              </div>
              {proposal.summary && (
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-on-surface-secondary">
                  {proposal.summary}
                </pre>
              )}
            </div>
          )}

          {canvas && shownSpec ? (
            <CostCanvasView
              spec={shownSpec}
              result={shownResult}
              api={client}
              changedBlockIds={previewing ? changedBlockIds : undefined}
              editing={
                canWrite && !previewing
                  ? {
                      onMove: (index, direction) => {
                        const blocks = [...canvas.spec.blocks];
                        const target = index + direction;
                        if (target < 0 || target >= blocks.length) return;
                        [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
                        void saveSpec({ ...canvas.spec, blocks });
                      },
                      onRemove: (index) => {
                        const blocks = canvas.spec.blocks.filter((_, i) => i !== index);
                        void saveSpec({ ...canvas.spec, blocks });
                      },
                      onEditChart: (index) => setEditingChart(index),
                    }
                  : undefined
              }
            />
          ) : (
            <p role="status" className="text-sm text-on-surface-faint">
              {gt("Loading canvas…")}
            </p>
          )}

          {canvas && canvas.placements.length > 0 && (
            <div className="text-xs text-on-surface-faint">
              {gt("Shown on:")}{" "}
              {canvas.placements.map((p, i) => (
                <span key={p.widgetId}>
                  {i > 0 ? ", " : ""}
                  {onOpenDashboard ? (
                    <button
                      type="button"
                      onClick={() => onOpenDashboard(p.dashboardId)}
                      className="underline hover:text-on-surface-secondary"
                    >
                      {p.dashboardName}
                    </button>
                  ) : (
                    p.dashboardName
                  )}
                </span>
              ))}
            </div>
          )}

          {delivery && (
            <DeliverySchedulesSection
              client={delivery}
              supportsPdf
              copy={{
                description: gt(
                  "Send this canvas's headline figures and a PDF to Slack, Microsoft Teams or email on a schedule.",
                ),
                editorDescription: gt(
                  "Each send uses its creator's cost visibility and doesn't call the assistant.",
                ),
              }}
            />
          )}
        </div>
      </div>

      {chatOpen && conversationId && client.chat && canvas && (
        <aside className="w-[420px] shrink-0 border-l border-border min-h-0 flex flex-col">
          <ConversationView
            key={conversationId}
            client={client.chat}
            conversationId={conversationId}
            initialMessage={
              canvas.spec.blocks.length === 0 && canvas.prompt ? canvas.prompt : undefined
            }
            onActivity={onChatActivity}
            placeholder={gt("Ask for a change, e.g. split by region")}
          />
        </aside>
      )}

      {editingChart !== null && canvas && canvas.spec.blocks[editingChart]?.kind === "chart" && (
        <CostGraphConfigModal
          initialConfig={(canvas.spec.blocks[editingChart] as { config: CostGraphConfig }).config}
          initialTitle={(canvas.spec.blocks[editingChart] as { title: string }).title}
          api={client}
          onSave={async (title, config) => {
            const blocks = canvas.spec.blocks.map((b, i) =>
              i === editingChart && b.kind === "chart" ? { ...b, title, config } : b,
            );
            await saveSpec({ ...canvas.spec, blocks });
            setEditingChart(null);
          }}
          onClose={() => setEditingChart(null)}
        />
      )}

      {placing && canvas && (
        <PlacementModal
          canvas={canvas}
          client={client}
          onClose={() => setPlacing(false)}
          onChanged={async () => {
            await loadCanvas();
          }}
        />
      )}

      {sharing && client.sharing && (
        <ShareDialog
          client={client.sharing}
          target={sharing}
          onClose={() => setSharing(null)}
          onSaved={() => void loadCanvas()}
        />
      )}
    </div>
  );
}

function bindDeliveryClient(
  client: CostCanvasesClient,
  canvasId: string,
): DeliverySchedulesClient | null {
  const list = client.listCanvasNotifications;
  if (!list) return null;
  const {
    listCanvasDeliveryTargets: targets,
    createCanvasNotification: create,
    updateCanvasNotification: update,
    deleteCanvasNotification: remove,
    sendCanvasNotificationNow: sendNow,
  } = client;
  return {
    list: () => list.call(client, canvasId),
    ...(targets ? { targets: () => targets.call(client, canvasId) } : {}),
    ...(create
      ? { create: (input: DeliveryScheduleInput) => create.call(client, canvasId, input) }
      : {}),
    ...(update
      ? {
          update: (id: string, input: DeliveryScheduleInput) =>
            update.call(client, canvasId, id, input),
        }
      : {}),
    ...(remove ? { remove: (id: string) => remove.call(client, canvasId, id) } : {}),
    ...(sendNow ? { sendNow: (id: string) => sendNow.call(client, canvasId, id) } : {}),
  };
}

function PlacementModal({
  canvas,
  client,
  onClose,
  onChanged,
}: {
  canvas: CostCanvas;
  client: CostCanvasesClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const gt = useGT();
  const [dashboards, setDashboards] = useState<CostsPanelDashboard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listDashboards?.()
      .then((rows) => setDashboards(rows ?? []))
      .catch((e: unknown) => setError(errorText(e)));
  }, [client]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      onClose();
    } catch (e: unknown) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Dashboards showing {name}", { name: canvas.name })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{gt("Pin to a dashboard")}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt("Removing a card leaves the canvas intact; editing the canvas updates every card.")}
        </p>
        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}
        {dashboards === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading dashboards…")}
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {(dashboards ?? []).map((d) => {
            const placement = canvas.placements.find((p) => p.dashboardId === d.id);
            return (
              <li key={d.id} className="flex items-center justify-between gap-3 py-1">
                <span className="truncate text-sm text-on-surface">{d.name}</span>
                {placement ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.removeCanvasPlacement!(placement.widgetId))
                    }
                    className="text-xs text-on-surface-faint hover:text-danger underline disabled:opacity-50"
                  >
                    {gt("Remove")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => client.addCanvasToDashboard!(d.id, canvas.id, canvas.name))
                    }
                    className="text-xs text-on-surface-secondary hover:text-on-surface underline disabled:opacity-50"
                  >
                    {gt("Add")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Done")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

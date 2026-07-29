// `infrawrench tui` — full-screen interactive dashboard. Hand-rolled ANSI
// renderer (alternate screen buffer + raw-mode keys), no curses dependency.
//
// Layout:
//   header   — org switcher tabs (Local + each cloud org)
//   left     — accounts in the active scope
//   right    — resources of the selected account, or the detail/metrics pane
//   footer   — key hints
import {
  listOrgs,
  listLocalAccounts,
  listCloudAccounts,
  listLocalResources,
  listCloudResources,
  loadLocalResourceOutputs,
  syncCloudAccount,
  fetchLocalMetrics,
  orgFetch,
  type AccountInfo,
  type CliContext,
  type OrgInfo,
  type ResourceRow,
} from "./context";
import { getAuthStatus } from "../cloud-tokens";
import { c, colorIsEnabled, seriesColor, visibleWidth, formatNumber, formatMoney } from "./output";
import { sparkline, lineChart, barChart } from "./charts";

const ESC = "\u001b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;

interface Scope {
  kind: "local" | "org";
  org: OrgInfo | null;
  label: string;
}

type Pane = "accounts" | "resources" | "detail" | "costs";

interface TuiState {
  scopes: Scope[];
  scopeIndex: number;
  accounts: AccountInfo[];
  accountIndex: number;
  /** First visible row of the accounts pane — keeps the cursor on screen. */
  accountScroll: number;
  resources: ResourceRow[];
  resourceIndex: number;
  /** First visible row of the resources list. */
  resourceScroll: number;
  /** First visible line of the detail pane (j/k scroll it — no cursor there). */
  detailScroll: number;
  pane: Pane;
  status: string;
  loading: boolean;
  /** True once the selected account's resources have been asked for. */
  resourcesLoaded: boolean;
  metrics: Array<{
    label: string;
    unit?: string;
    points: Array<{ timestamp: number; value: number }>;
  }> | null;
  costs: {
    totals: Record<string, number>;
    series: Array<{
      key: string;
      label: string;
      currency: string;
      points: Array<{ bucket: string; amount: number }>;
    }>;
  } | null;
}

function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  // Only safe on plain (uncolored) strings; callers color after truncating.
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Clamp a pane's scroll offset so the cursor row stays on screen and the
 * window never runs past the end of the list. Called on every render — the
 * terminal can resize between key presses, so the offset is re-derived from
 * the current geometry rather than maintained by the key handlers.
 */
function followScroll(scroll: number, index: number, visible: number, total: number): number {
  if (visible <= 0 || total <= visible) return 0;
  let next = Math.min(scroll, total - visible);
  if (index < next) next = index;
  if (index >= next + visible) next = index - visible + 1;
  return Math.max(0, next);
}

export async function runTui(ctx: CliContext): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      "The TUI needs an interactive terminal. Use `infrawrench accounts --json` for scripts.",
    );
  }

  const scopes: Scope[] = [{ kind: "local", org: null, label: "Local" }];
  if ((await getAuthStatus()).authenticated) {
    for (const org of await listOrgs()) {
      scopes.push({ kind: "org", org, label: org.displayName });
    }
  }

  const state: TuiState = {
    scopes,
    scopeIndex: 0,
    accounts: [],
    accountIndex: 0,
    accountScroll: 0,
    resources: [],
    resourceIndex: 0,
    resourceScroll: 0,
    detailScroll: 0,
    pane: "accounts",
    status: "",
    loading: true,
    resourcesLoaded: false,
    metrics: null,
    costs: null,
  };

  const out = process.stdout;
  let alive = true;

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    out.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  };
  process.on("exit", cleanup);

  out.write(ALT_SCREEN_ON + CURSOR_HIDE);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  const activeScope = () => state.scopes[state.scopeIndex]!;
  const activeAccount = (): AccountInfo | undefined => state.accounts[state.accountIndex];
  const activeResource = (): ResourceRow | undefined => state.resources[state.resourceIndex];

  // Listing an account goes out to the provider, so a stale reply from a
  // previously-selected account must not land on top of the current one.
  let resourceLoadToken = 0;

  async function loadAccounts(): Promise<void> {
    state.loading = true;
    render();
    try {
      const scope = activeScope();
      state.accounts =
        scope.kind === "local" ? await listLocalAccounts() : await listCloudAccounts(scope.org!.id);
      state.accountIndex = 0;
      state.accountScroll = 0;
      clearResources();
      state.status = "";
    } catch (e) {
      state.status = e instanceof Error ? e.message : String(e);
      state.accounts = [];
    }
    state.loading = false;
    render();
  }

  function clearResources(): void {
    // Invalidate any in-flight listing/sync — its reply belongs to whatever
    // account was selected when it started, not this one.
    resourceLoadToken++;
    state.resources = [];
    state.resourceIndex = 0;
    state.resourceScroll = 0;
    state.detailScroll = 0;
    state.resourcesLoaded = false;
    state.metrics = null;
  }

  async function loadResources(): Promise<void> {
    const account = activeAccount();
    if (!account) return;
    const token = ++resourceLoadToken;
    state.loading = true;
    state.resourcesLoaded = true;
    render();
    try {
      const scope = activeScope();
      if (scope.kind === "local") {
        const { rows, errors } = await listLocalResources(account);
        if (token !== resourceLoadToken) return;
        state.resources = rows;
        state.status = errors.length
          ? errors.map((e) => `${e.typeId}: ${e.message}`).join(" · ")
          : "";
        state.resourceIndex = 0;
        state.resourceScroll = 0;
      } else {
        // Cached rows first so the pane fills instantly…
        const cached = await listCloudResources(scope.org!.id, account.id);
        if (token !== resourceLoadToken) return;
        state.resources = cached;
        state.resourceIndex = 0;
        state.resourceScroll = 0;
        state.loading = false;
        state.status = "syncing from provider…";
        render();
        // …then a live sync so the listing matches what the provider has now
        // (the desktop account page re-syncs the same way). A failed sync
        // keeps the cached rows on screen instead of wiping the pane.
        try {
          await syncCloudAccount(scope.org!.id, account.id);
          const fresh = await listCloudResources(scope.org!.id, account.id);
          if (token !== resourceLoadToken) return;
          state.resources = fresh;
          state.resourceIndex = Math.min(state.resourceIndex, Math.max(0, fresh.length - 1));
          state.status = "";
        } catch (e) {
          if (token !== resourceLoadToken) return;
          state.status = `sync failed — showing cached: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    } catch (e) {
      if (token !== resourceLoadToken) return;
      state.status = e instanceof Error ? e.message : String(e);
      state.resources = [];
    }
    state.loading = false;
    render();
  }

  /** Fill in the selected resource's outputs — local listings arrive without them. */
  async function loadResourceOutputs(): Promise<void> {
    const scope = activeScope();
    const account = activeAccount();
    const resource = activeResource();
    if (scope.kind !== "local" || !account || !resource) return;
    const index = state.resourceIndex;
    try {
      const enriched = await loadLocalResourceOutputs(account, resource);
      if (state.resources[index]?.id !== resource.id) return;
      state.resources[index] = enriched;
      render();
    } catch {
      /* outputs are a bonus on the detail pane — the fields still render */
    }
  }

  // Metrics arrive async while the user may already be looking at another
  // resource — same staleness hazard as resource listing.
  let metricsLoadToken = 0;

  async function loadMetrics(): Promise<void> {
    const scope = activeScope();
    const resource = activeResource();
    const account = activeAccount();
    state.metrics = null;
    if (!resource || !account) return;
    const token = ++metricsLoadToken;
    const endMs = Date.now();
    const startMs = endMs - 6 * 60 * 60 * 1000;
    try {
      if (scope.kind === "local") {
        // Live from the plugin, exactly as the GUI's Metrics tab does.
        const series = await fetchLocalMetrics(account, resource.resourceTypeId, resource.id, {
          startMs,
          endMs,
        });
        if (token !== metricsLoadToken) return;
        state.metrics = series;
      } else {
        const { series } = await orgFetch<{ series: NonNullable<TuiState["metrics"]> }>(
          scope.org!.id,
          `/resources/${encodeURIComponent(account.pluginId)}/${encodeURIComponent(resource.resourceTypeId)}/metrics`,
          {
            method: "POST",
            body: JSON.stringify({
              accountId: account.id,
              resourceId: resource.id,
              startMs,
              endMs,
            }),
          },
        );
        if (token !== metricsLoadToken) return;
        state.metrics = series;
      }
    } catch {
      if (token !== metricsLoadToken) return;
      state.metrics = [];
    }
    render();
  }

  async function loadCosts(): Promise<void> {
    const scope = activeScope();
    state.costs = null;
    if (scope.kind !== "org") {
      state.status = "Costs are a cloud feature — switch to an organization (o).";
      render();
      return;
    }
    state.loading = true;
    render();
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
      state.costs = await orgFetch(scope.org!.id, "/costs/query", {
        method: "POST",
        body: JSON.stringify({
          from,
          to,
          binning: "daily",
          groupBy: "provider",
          filters: [],
          topN: 6,
          comparePreviousPeriod: false,
          forecast: false,
        }),
      });
      state.status = "";
    } catch (e) {
      state.status = e instanceof Error ? e.message : String(e);
    }
    state.loading = false;
    render();
  }

  function render(): void {
    if (!alive) return;
    // `||`, not `??`: a pty with no window size reports 0, and 0 columns sends
    // the cursor to negative rows and paints garbage. Floors keep the geometry
    // (bodyRows, rightWidth) non-negative on a genuinely tiny terminal too.
    const cols = Math.max(30, out.columns || 80);
    const rows = Math.max(8, out.rows || 24);
    const leftWidth = Math.max(24, Math.min(36, Math.floor(cols * 0.32)));
    const rightWidth = cols - leftWidth - 3;
    const bodyRows = rows - 4; // header(2) + footer(1) + status(1)

    let buf = CLEAR;

    // Header: scope tabs
    const tabs = state.scopes
      .map((s, i) => {
        const label = ` ${s.label} `;
        return i === state.scopeIndex ? c.bold(c.cyan(`[${label}]`)) : c.dim(` ${label} `);
      })
      .join("");
    buf += moveTo(1, 1) + truncateAnsiSafe(` ${c.bold("Infrawrench")}  ${tabs}`, cols);
    buf += moveTo(2, 1) + c.dim("─".repeat(cols));

    // Left pane: accounts, windowed so the cursor is always on screen.
    state.accountScroll = followScroll(
      state.accountScroll,
      state.accountIndex,
      bodyRows,
      state.accounts.length,
    );
    for (let i = 0; i < bodyRows; i++) {
      const account = state.accounts[state.accountScroll + i];
      let line = "";
      if (account) {
        const selected = state.accountScroll + i === state.accountIndex;
        const marker = selected ? (state.pane === "accounts" ? c.cyan("▶ ") : c.dim("▶ ")) : "  ";
        const name = truncate(account.displayName, leftWidth - 4);
        line = marker + (selected ? c.bold(name) : name);
        const plugin = truncate(account.pluginId, leftWidth - visibleWidth(line) - 2);
        line += ` ${c.dim(plugin)}`;
      } else if (i === 0 && state.accounts.length === 0) {
        line = c.dim(state.loading ? "  loading…" : "  (no accounts)");
      }
      buf +=
        moveTo(3 + i, 1) +
        truncateAnsiSafe(line, leftWidth) +
        moveTo(3 + i, leftWidth + 2) +
        c.dim("│");
    }

    // Right pane
    let right: string[] = [];
    if (state.pane === "costs") {
      renderCostsPane(right, rightWidth);
    } else if (state.pane === "detail") {
      renderDetailPane(right, rightWidth);
      // The detail pane has no cursor — j/k slide the whole pane instead.
      state.detailScroll = Math.max(0, Math.min(state.detailScroll, right.length - bodyRows));
      if (state.detailScroll > 0) {
        right = right.slice(state.detailScroll);
        right[0] = c.dim(`↑ ${state.detailScroll} more`);
      }
    } else {
      renderResourcesPane(right, rightWidth, bodyRows);
    }
    for (let i = 0; i < bodyRows; i++) {
      buf += moveTo(3 + i, leftWidth + 4) + truncateAnsiSafe(right[i] ?? "", rightWidth);
    }

    // Status + footer
    buf += moveTo(rows - 1, 1) + truncateAnsiSafe(state.status ? c.yellow(state.status) : "", cols);
    const hints =
      state.pane === "detail"
        ? "↑↓/jk scroll · esc back · m refresh metrics · q quit"
        : "↑↓/jk move · tab pane · enter open · o org · c costs · r refresh · q quit";
    buf += moveTo(rows, 1) + truncateAnsiSafe(c.dim(` ${hints}`), cols);

    out.write(buf);
  }

  function renderResourcesPane(lines: string[], width: number, bodyRows: number): void {
    const account = activeAccount();
    if (!account) {
      lines.push(c.dim("Select an account."));
      return;
    }
    const position =
      state.resources.length > 0 ? ` ${state.resourceIndex + 1}/${state.resources.length}` : "";
    lines.push(
      `${c.bold(truncate(account.displayName, width - 12))} ${c.dim(`(${account.pluginId})${position}`)}`,
    );
    lines.push("");
    if (state.resources.length === 0) {
      if (state.loading) lines.push(c.dim("loading…"));
      else if (!state.resourcesLoaded) lines.push(c.dim("Press enter to list this account."));
      else lines.push(c.dim("No resources in this account."));
      return;
    }
    const typeIndex = new Map<string, number>();
    for (const r of state.resources) {
      if (!typeIndex.has(r.resourceTypeId)) typeIndex.set(r.resourceTypeId, typeIndex.size);
    }
    // Two header lines above the list — window the rest around the cursor.
    const visible = Math.max(1, bodyRows - 2);
    state.resourceScroll = followScroll(
      state.resourceScroll,
      state.resourceIndex,
      visible,
      state.resources.length,
    );
    state.resources
      .slice(state.resourceScroll, state.resourceScroll + visible)
      .forEach((r, offset) => {
        const i = state.resourceScroll + offset;
        const selected = i === state.resourceIndex && state.pane === "resources";
        const marker = selected ? c.cyan("▶ ") : "  ";
        const type = seriesColor(typeIndex.get(r.resourceTypeId) ?? 0)(
          truncate(r.resourceTypeId, 18).padEnd(18),
        );
        const name = truncate(r.displayName, Math.max(8, width - 24));
        lines.push(marker + type + " " + (selected ? c.bold(name) : name));
      });
  }

  function renderDetailPane(lines: string[], width: number): void {
    const resource = activeResource();
    if (!resource) {
      lines.push(c.dim("No resource selected."));
      return;
    }
    lines.push(
      `${c.bold(truncate(resource.displayName, width - 20))} ${c.dim(`(${resource.resourceTypeId})`)}`,
    );
    lines.push(c.dim(truncate(resource.id, width)));
    lines.push("");
    // Everything scalar the desktop detail page would show — the pane
    // scrolls, so nothing gets sliced away.
    const sections: Array<[string, Array<[string, unknown]>]> = [
      ["", Object.entries(resource.fields)],
      ["outputs", Object.entries(resource.outputs)],
    ];
    for (const [heading, entries] of sections) {
      const scalars = entries.filter(([, v]) => typeof v !== "object" || v === null);
      if (scalars.length === 0) continue;
      if (heading) {
        lines.push("");
        lines.push(c.dim(heading));
      }
      for (const [k, v] of scalars) {
        lines.push(
          `${c.dim(truncate(k, 20).padEnd(20))} ${truncate(String(v ?? "—"), width - 21)}`,
        );
      }
    }
    lines.push("");
    if (state.metrics === null) {
      lines.push(c.dim("Loading metrics…"));
      return;
    }
    if (state.metrics.length === 0) {
      lines.push(c.dim("No metrics reported for this resource."));
      return;
    }
    for (const s of state.metrics) {
      const values = s.points.map((p) => p.value);
      const now = values.length > 0 ? formatNumber(values[values.length - 1]!, s.unit) : "—";
      lines.push(`${c.bold(truncate(s.label, 28))} ${c.dim("6h")} ${c.dim("now")} ${now}`);
      for (const line of lineChart(values, {
        width: Math.max(20, width - 12),
        height: 4,
        unit: s.unit,
      })) {
        lines.push(line);
      }
    }
  }

  function renderCostsPane(lines: string[], width: number): void {
    lines.push(c.bold("Costs · last 30 days"));
    lines.push("");
    if (!state.costs) {
      lines.push(c.dim(state.loading ? "loading…" : "No cost data."));
      return;
    }
    const totalLine = Object.entries(state.costs.totals)
      .map(([currency, amount]) => formatMoney(amount, currency))
      .join(" + ");
    lines.push(`${c.dim("total")} ${c.bold(totalLine || "—")}`);
    const byBucket = new Map<string, number>();
    for (const s of state.costs.series) {
      for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
    }
    const daily = [...byBucket.keys()].sort().map((b) => byBucket.get(b)!);
    lines.push(`${c.dim("daily")} ${seriesColor(0)(sparkline(daily, Math.min(width - 8, 45)))}`);
    lines.push("");
    const items = state.costs.series.map((s, idx) => {
      const total = s.points.reduce((sum, p) => sum + p.amount, 0);
      return {
        label: truncate(s.key === "__other__" ? "other" : s.label, 16),
        value: total,
        display: formatMoney(total, s.currency),
        colorIndex: idx,
      };
    });
    for (const line of barChart(items, Math.max(10, Math.min(30, width - 30)))) lines.push(line);
  }

  // ANSI-aware truncation: drop the line if it overflows rather than slicing
  // through an escape sequence; pad-free since we always reposition.
  function truncateAnsiSafe(line: string, width: number): string {
    if (visibleWidth(line) <= width) return line;
    if (!colorIsEnabled()) return truncate(line, width);
    // Walk the string keeping escapes, counting visible chars.
    let visible = 0;
    let outStr = "";
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ESC) {
        const end = line.indexOf("m", i);
        if (end === -1) break;
        outStr += line.slice(i, end + 1);
        i = end;
        continue;
      }
      if (visible >= width - 1) break;
      outStr += line[i];
      visible++;
    }
    return `${outStr}${ESC}[0m…`;
  }

  function moveSelection(delta: number): void {
    if (state.pane === "accounts") {
      const next = state.accountIndex + delta;
      if (next >= 0 && next < state.accounts.length) {
        state.accountIndex = next;
        // Listing hits the provider, so moving the cursor only clears the
        // pane — enter is what asks for the new account's resources.
        clearResources();
        render();
      }
    } else if (state.pane === "resources") {
      const next = state.resourceIndex + delta;
      if (next >= 0 && next < state.resources.length) {
        state.resourceIndex = next;
        render();
      }
    } else if (state.pane === "detail") {
      // No cursor in the detail pane — j/k scroll the content itself.
      // render() clamps to the pane's real height.
      state.detailScroll = Math.max(0, state.detailScroll + delta);
      render();
    }
  }

  await loadAccounts();
  if (state.accounts.length > 0) await loadResources();

  await new Promise<void>((resolve) => {
    const onResize = () => render();
    process.stdout.on("resize", onResize);

    process.stdin.on("data", (data: Buffer) => {
      const key = data.toString("utf8");
      if (key === "q" || key === "\u0003" /* ctrl-c */) {
        process.stdout.removeListener("resize", onResize);
        resolve();
        return;
      }
      if (key === `${ESC}[A` || key === "k") moveSelection(-1);
      else if (key === `${ESC}[B` || key === "j") moveSelection(1);
      else if (key === "\t") {
        state.pane = state.pane === "accounts" ? "resources" : "accounts";
        render();
      } else if (key === "\r" || key === "\n") {
        if (state.pane === "accounts") {
          state.pane = "resources";
          void loadResources();
        } else if (state.pane === "resources") {
          if (activeResource()) {
            state.pane = "detail";
            state.detailScroll = 0;
            render();
            void loadResourceOutputs();
            void loadMetrics();
          } else if (!state.loading) {
            // Tabbed into the pane before listing it — enter still means
            // "list this account", exactly as the placeholder text says.
            void loadResources();
          }
        }
      } else if (key === ESC && state.pane === "detail") {
        state.pane = "resources";
        state.detailScroll = 0;
        render();
      } else if (key === ESC && state.pane === "costs") {
        state.pane = "accounts";
        render();
      } else if (key === "o") {
        state.scopeIndex = (state.scopeIndex + 1) % state.scopes.length;
        state.pane = "accounts";
        void loadAccounts();
      } else if (key === "c") {
        state.pane = "costs";
        void loadCosts();
      } else if (key === "r") {
        if (state.pane === "costs") void loadCosts();
        else if (state.pane === "detail") void loadMetrics();
        else if (state.pane === "resources") void loadResources();
        else void loadAccounts();
      } else if (key === "m" && state.pane === "detail") {
        void loadMetrics();
      }
    });
  });

  cleanup();
}

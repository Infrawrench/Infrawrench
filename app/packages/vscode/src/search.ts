import * as vscode from "vscode";
import {
  SERVICE_TIER_LABELS,
  fetchServices,
  filterServices,
  EDITOR_SEARCH_KINDS,
  SEARCH_KIND_LABELS,
  isWorkflowSearchResult,
  objectSearchResults,
  searchOrg,
  searchResultKind,
  webWorkflowUrl,
  type SearchResult,
  type Service,
} from "@infrawrench/client-core";
import { TtlCache } from "./cache";
import { openObject, openResource, openService, openUrl } from "./open";
import type { Session } from "./session";

type Item = vscode.QuickPickItem & {
  result?: SearchResult;
  service?: Service;
};

const servicesCache = new TtlCache<Service[]>(60 * 1000);

/**
 * Command-palette search over the org's search index (resources, workflows,
 * and saved objects: cost reports, dashboards, budgets, SLOs, runbooks…) plus
 * the org's services, filtered client-side from `/services` because that
 * listing carries tier, owners and on-call the search hit does not.
 */
export async function runSearch(session: Session): Promise<void> {
  const api = session.api;
  const orgId = session.orgId;
  if (!api || !orgId) {
    await vscode.commands.executeCommand("infrawrench.signIn");
    return;
  }
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Search ${session.orgName ?? "Infrawrench"}`;
  qp.placeholder = "Resource, service, report, dashboard, SLO or other name";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (value: string) => {
    const mine = ++generation;
    qp.busy = true;
    void (async () => {
      try {
        const [results, services] = await Promise.all([
          value.trim().length >= 2
            ? searchOrg(api, orgId, value, undefined, { kinds: EDITOR_SEARCH_KINDS })
            : Promise.resolve([]),
          servicesCache
            .get(orgId, async () => (await fetchServices(api, orgId)).services)
            .catch(() => [] as Service[]),
        ]);
        if (mine !== generation) return;
        qp.items = toItems(results, filterServices(services, value));
      } catch (err) {
        if (mine !== generation) return;
        qp.items = [
          {
            label: "$(error) Search failed",
            detail: err instanceof Error ? err.message : String(err),
            alwaysShow: true,
          },
        ];
      } finally {
        if (mine === generation) qp.busy = false;
      }
    })();
  };
  qp.onDidChangeValue((value) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => update(value), 250);
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (item?.service) await openService(session, item.service.id);
    else if (item?.result) await actOnResult(session, orgId, item.result);
  });
  qp.onDidHide(() => qp.dispose());
  update("");
  qp.show();
}

function toItems(results: SearchResult[], services: Service[]): Item[] {
  const items: Item[] = [];
  if (services.length > 0) {
    items.push({ label: "Services", kind: vscode.QuickPickItemKind.Separator });
    for (const s of services.slice(0, 20)) {
      items.push({
        label: `$(layers) ${s.name}`,
        description: [s.tier ? SERVICE_TIER_LABELS[s.tier] : null, s.ownerTeam]
          .filter(Boolean)
          .join(" · "),
        detail: `${s.memberCount} resource(s)${s.onCallScheduleName ? ` · on call: ${s.onCallScheduleName}` : ""}`,
        alwaysShow: true,
        service: s,
      });
    }
  }
  const resources = results.filter((r) => searchResultKind(r) === "resource");
  const workflows = results.filter((r) => searchResultKind(r) === "workflow");
  if (resources.length > 0) {
    items.push({ label: "Resources", kind: vscode.QuickPickItemKind.Separator });
    for (const r of resources) {
      items.push({
        label: `$(server) ${r.displayName}`,
        description: `${r.pluginDisplayName} ${r.resourceTypeLabel}`,
        detail: r.accountName,
        alwaysShow: true,
        result: r,
      });
    }
  }
  if (workflows.length > 0) {
    items.push({ label: "Workflows", kind: vscode.QuickPickItemKind.Separator });
    for (const r of workflows) {
      items.push({
        label: `$(run-all) ${r.displayName}`,
        description: r.subtitle ?? "",
        alwaysShow: true,
        result: r,
      });
    }
  }
  // Saved objects, one separator per kind, in the server's order.
  let lastKind: string | null = null;
  for (const o of objectSearchResults(results)) {
    if (o.kind !== lastKind) {
      items.push({
        label: SEARCH_KIND_LABELS[o.kind].plural,
        kind: vscode.QuickPickItemKind.Separator,
      });
      lastKind = o.kind;
    }
    items.push({
      label: `$(file) ${o.displayName}`,
      description: o.subtitle ?? "",
      alwaysShow: true,
      result: o,
    });
  }
  return items;
}

async function actOnResult(session: Session, orgId: string, r: SearchResult): Promise<void> {
  if (isWorkflowSearchResult(r)) {
    await openUrl(webWorkflowUrl(session.cloudUrl, orgId, r.id));
    return;
  }
  const [object] = objectSearchResults([r]);
  if (object) {
    await openObject(session, object.kind, object.id);
    return;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(link-external) Open in Infrawrench", id: "open" },
      { label: "$(copy) Copy resource ID", id: "copy-id" },
      { label: "$(copy) Copy name", id: "copy-name" },
    ],
    { title: r.displayName },
  );
  if (!action) return;
  if (action.id === "open") {
    await openResource(session, {
      accountId: r.accountId,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      resourceId: r.id,
    });
  } else {
    await vscode.env.clipboard.writeText(action.id === "copy-id" ? r.id : r.displayName);
    void vscode.window.setStatusBarMessage("Copied", 2000);
  }
}

export function clearSearchCache(): void {
  servicesCache.clear();
}

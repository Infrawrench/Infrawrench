import * as vscode from "vscode";
import {
  POSTURE_SEVERITIES,
  SERVICE_TIER_LABELS,
  fetchServiceDetail,
  fetchServiceSummary,
  fetchServices,
  formatMonthlyEstimate,
  formatScorecardScore,
  type Service,
  type ServiceMember,
  type ServiceSummaryResponse,
} from "@infrawrench/client-core";
import type { Session } from "./session";

/**
 * The Services view: the org's service catalog, each service expanding into
 * its standing (on call, 30-day cost, posture, scorecards) and its member
 * resources. Read-only; editing services stays in the app, one click away.
 */
type Node =
  | { kind: "service"; service: Service }
  | { kind: "fact"; label: string; description?: string | undefined; icon: string }
  | { kind: "open"; service: Service }
  | { kind: "members"; service: Service }
  | { kind: "member"; member: ServiceMember }
  | { kind: "message"; label: string };

export class ServicesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly session: Session) {
    session.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "service": {
        const s = node.service;
        const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = [s.tier ? SERVICE_TIER_LABELS[s.tier] : null, s.ownerTeam]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = new vscode.MarkdownString(
          [
            `**${s.name}**`,
            s.description ?? "",
            `${s.memberCount} resource(s)`,
            ...s.scores.map(
              (b) => `${b.scorecardName}: ${b.levelName ?? formatScorecardScore(b.score)}`,
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        item.iconPath = new vscode.ThemeIcon("layers");
        item.contextValue = "service";
        item.id = `service:${s.id}`;
        return item;
      }
      case "fact": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        if (node.description) item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "open": {
        const item = new vscode.TreeItem(
          "Open in Infrawrench",
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon("link-external");
        item.command = {
          title: "Open in Infrawrench",
          command: "infrawrench.openService",
          arguments: [{ id: node.service.id }],
        };
        return item;
      }
      case "members": {
        const item = new vscode.TreeItem(
          `Resources (${node.service.memberCount})`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon("server");
        return item;
      }
      case "member": {
        const m = node.member;
        const item = new vscode.TreeItem(m.resourceName, vscode.TreeItemCollapsibleState.None);
        item.description = [m.accountName, m.resourceTypeId, m.missing ? "missing" : null]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(m.missing ? "warning" : "symbol-field");
        item.command = {
          title: "Open in Infrawrench",
          command: "infrawrench.openResource",
          arguments: [
            {
              accountId: m.accountId,
              pluginId: m.pluginId,
              resourceTypeId: m.resourceTypeId,
              resourceId: m.resourceId,
            },
          ],
        };
        return item;
      }
      case "message":
        return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const api = this.session.api;
    const orgId = this.session.orgId;
    if (!api || !orgId) return [];
    try {
      if (!node) {
        const { services } = await fetchServices(api, orgId);
        if (services.length === 0) {
          return [{ kind: "message", label: "No services yet. Define them in Infrawrench." }];
        }
        return [...services]
          .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.name.localeCompare(b.name))
          .map((service) => ({ kind: "service", service }));
      }
      if (node.kind === "service") {
        const summary = await fetchServiceSummary(api, orgId, node.service.id);
        return [
          ...(summary ? summaryFacts(summary) : []),
          { kind: "open", service: node.service },
          { kind: "members", service: node.service },
        ];
      }
      if (node.kind === "members") {
        const detail = await fetchServiceDetail(api, orgId, node.service.id);
        return (detail?.members ?? []).map((member) => ({ kind: "member", member }));
      }
    } catch (err) {
      return [
        {
          kind: "message",
          label: `Couldn't load: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
    return [];
  }
}

function summaryFacts(s: ServiceSummaryResponse): Node[] {
  const facts: Node[] = [];
  if (s.onCall) {
    const who = s.onCall.current?.name ?? s.onCall.current?.email ?? "nobody";
    facts.push({
      kind: "fact",
      label: `On call: ${who}`,
      description: s.onCall.scheduleName,
      icon: "bell",
    });
  }
  if (s.cost.available && s.cost.totals.length > 0) {
    facts.push({
      kind: "fact",
      label: `Cost: ${s.cost.totals.map((t) => formatMonthlyEstimate(Math.round(t.amount * 100) / 100, t.currency)).join(" + ")}`,
      description: `last ${s.cost.windowDays} days`,
      icon: "graph",
    });
  }
  const counts = s.findings.posture.counts;
  const open = POSTURE_SEVERITIES.reduce((n, sev) => n + counts[sev], 0);
  facts.push({
    kind: "fact",
    label: open === 0 ? "Posture: no open findings" : `Posture: ${open} open finding(s)`,
    description:
      open === 0
        ? undefined
        : POSTURE_SEVERITIES.filter((sev) => counts[sev] > 0)
            .map((sev) => `${counts[sev]} ${sev}`)
            .join(", "),
    icon: open === 0 ? "pass" : "shield",
  });
  for (const card of s.scorecards) {
    facts.push({
      kind: "fact",
      label: `${card.scorecardName}: ${card.levelName ?? formatScorecardScore(card.score)}`,
      icon: "checklist",
    });
  }
  return facts;
}

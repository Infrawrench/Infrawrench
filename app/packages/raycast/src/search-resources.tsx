import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  IAC_STATUS_LABELS,
  POSTURE_SEVERITY_LABELS,
  SERVICE_TIER_LABELS,
  describeResourceVulnerabilities,
  fetchServiceDetail,
  fetchServiceSummary,
  fetchServices,
  filterServices,
  formatMonthlyEstimate,
  formatScorecardScore,
  incidentSeverityLabel,
  isWorkflowSearchResult,
  searchOrg,
  webWorkflowUrl,
  type ResourceVulnerabilityTally,
  type SearchResult,
  type Service,
} from "@infrawrench/client-core";
import { getClient, type Client } from "./lib/client";
import { DeclareIncidentForm } from "./lib/declare-form";
import { formatSpend } from "./lib/format";
import { loadResourceInsight, type Part } from "./lib/insight";
import {
  destinationsFor,
  openPreferred,
  vulnerabilitiesDestinations,
  type Destinations,
} from "./lib/open";

export default function Command() {
  const client = getClient();
  const [query, setQuery] = useState("");
  const [showDetail, setShowDetail] = useState(true);

  const search = useCachedPromise(
    (orgId: string, q: string) =>
      q.trim().length >= 2 ? searchOrg(client.api, orgId, q) : Promise.resolve([]),
    [client.orgId, query],
    { keepPreviousData: true },
  );
  const services = useCachedPromise(
    async (orgId: string) => (await fetchServices(client.api, orgId)).services,
    [client.orgId],
  );

  const matchedServices = filterServices(services.data ?? [], query).slice(0, 20);
  const results = search.data ?? [];
  const resources = results.filter((r) => !isWorkflowSearchResult(r));
  const workflows = results.filter(isWorkflowSearchResult);
  const error = search.error ?? services.error;

  return (
    <List
      isLoading={search.isLoading || services.isLoading}
      onSearchTextChange={setQuery}
      throttle
      isShowingDetail={showDetail && (resources.length > 0 || matchedServices.length > 0)}
      searchBarPlaceholder="Search resources, accounts, providers, services"
    >
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Couldn't reach Infrawrench"
          description={error.message}
        />
      ) : (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title={query.trim().length < 2 ? "Type to search" : "No matches"}
          description="Resources across every connected account, plus your services."
        />
      )}
      <List.Section title="Services">
        {matchedServices.map((s) => (
          <ServiceItem
            key={s.id}
            client={client}
            service={s}
            onToggleDetail={() => setShowDetail((v) => !v)}
          />
        ))}
      </List.Section>
      <List.Section title="Resources" subtitle={resources.length >= 50 ? "first 50" : undefined}>
        {resources.map((r) => (
          <ResourceItem
            key={r.id}
            client={client}
            result={r}
            onToggleDetail={() => setShowDetail((v) => !v)}
          />
        ))}
      </List.Section>
      <List.Section title="Workflows">
        {workflows.map((w) => (
          <List.Item
            key={w.id}
            icon={Icon.Bolt}
            title={w.displayName}
            subtitle={w.subtitle}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser url={webWorkflowUrl(client.cloudUrl, client.orgId, w.id)} />
                <Action.CopyToClipboard title="Copy Workflow ID" content={w.id} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function OpenActions({ client, dest }: { client: Client; dest: Destinations }) {
  const preferWeb = client.openIn === "web";
  return (
    <>
      <Action
        title="Open in Infrawrench"
        icon={Icon.ArrowRight}
        onAction={() => void openPreferred(client, dest)}
      />
      {preferWeb ? (
        <Action.Open title="Open in Desktop App" icon={Icon.AppWindow} target={dest.desktop} />
      ) : (
        <Action.OpenInBrowser title="Open in Web App" url={dest.web} />
      )}
    </>
  );
}

function ResourceItem({
  client,
  result: r,
  onToggleDetail,
}: {
  client: Client;
  result: SearchResult;
  onToggleDetail: () => void;
}) {
  const dest = destinationsFor(client, {
    kind: "resource",
    orgId: client.orgId,
    accountId: r.accountId,
    pluginId: r.pluginId,
    resourceTypeId: r.resourceTypeId,
    resourceId: r.id,
  });
  return (
    <List.Item
      icon={r.pluginLogoSvg ? { source: svgDataUri(r.pluginLogoSvg) } : Icon.HardDrive}
      title={r.displayName}
      subtitle={r.resourceTypeLabel}
      keywords={[r.accountName, r.pluginDisplayName]}
      detail={<ResourceDetail client={client} result={r} />}
      actions={
        <ActionPanel>
          <OpenActions client={client} dest={dest} />
          <Action.CopyToClipboard title="Copy Resource ID" content={r.id} />
          <Action.CopyToClipboard title="Copy Name" content={r.displayName} />
          <Action.CopyToClipboard
            title="Copy Link"
            content={dest.web}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action
            title="Open Vulnerabilities"
            icon={Icon.Bug}
            onAction={() => void openPreferred(client, vulnerabilitiesDestinations(client))}
          />
          <Action.Push
            title="Declare Incident Affecting This"
            icon={Icon.ExclamationMark}
            shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
            target={
              <DeclareIncidentForm affectedResourceIds={[r.id]} affectedLabel={r.displayName} />
            }
          />
          <Action
            title="Toggle Details"
            icon={Icon.Sidebar}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={onToggleDetail}
          />
        </ActionPanel>
      }
    />
  );
}

function partText<T>(p: Part<T> | undefined, render: (v: T) => string): string {
  if (!p) return "…";
  return p.ok ? render(p.value) : "Unavailable";
}

function ResourceDetail({ client, result: r }: { client: Client; result: SearchResult }) {
  const { data, isLoading } = useCachedPromise(
    (id: string) => loadResourceInsight(client, { ...r, id }),
    [r.id],
  );
  const findings = data?.findings.ok ? data.findings.value : [];
  const incidents = data?.incidents.ok ? data.incidents.value : [];
  const services = data?.services.ok ? data.services.value : [];
  const iac = data?.iac.ok ? data.iac.value : null;
  return (
    <List.Item.Detail
      isLoading={isLoading}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Provider" text={r.pluginDisplayName} />
          <List.Item.Detail.Metadata.Label title="Type" text={r.resourceTypeLabel} />
          <List.Item.Detail.Metadata.Label title="Account" text={r.accountName} />
          <List.Item.Detail.Metadata.Label
            title="Status"
            text={data ? (data.status ?? "Not reported") : "…"}
          />
          {data?.row?.externalId ? (
            <List.Item.Detail.Metadata.Label title="Provider ID" text={data.row.externalId} />
          ) : null}
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label
            title="Cost (30 days)"
            text={partText(data?.spend, formatSpend)}
          />
          <List.Item.Detail.Metadata.Label
            title="Terraform"
            text={
              data?.iac.ok
                ? iac?.status
                  ? `${IAC_STATUS_LABELS[iac.status]}${iac.terraformAddress ? ` (${iac.terraformAddress})` : ""}`
                  : "No uploaded state covers it"
                : partText(data?.iac, () => "")
            }
          />
          {services.length > 0 ? (
            <List.Item.Detail.Metadata.TagList title="Service">
              {services.map((s) => (
                <List.Item.Detail.Metadata.TagList.Item
                  key={s.id}
                  text={s.tier ? `${s.name} (${SERVICE_TIER_LABELS[s.tier]})` : s.name}
                />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : (
            <List.Item.Detail.Metadata.Label
              title="Service"
              text={partText(data?.services, () => "None")}
            />
          )}
          <List.Item.Detail.Metadata.Separator />
          {findings.length > 0 ? (
            <List.Item.Detail.Metadata.TagList title={`Posture (${findings.length})`}>
              {findings.slice(0, 6).map((f) => (
                <List.Item.Detail.Metadata.TagList.Item
                  key={f.ruleId}
                  text={`${POSTURE_SEVERITY_LABELS[f.severity]}: ${f.title}`}
                  color={
                    f.severity === "critical" || f.severity === "high" ? Color.Red : Color.Orange
                  }
                />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : (
            <List.Item.Detail.Metadata.Label
              title="Posture"
              text={partText(data?.findings, () => "No open findings")}
            />
          )}
          <VulnerabilitiesRow part={data?.vulnerabilities} />
          {incidents.length > 0 ? (
            <List.Item.Detail.Metadata.TagList title="Open incidents">
              {incidents.map((i) => (
                <List.Item.Detail.Metadata.TagList.Item
                  key={i.id}
                  text={`${incidentSeverityLabel(i.severity)}: ${i.title}`}
                  color={Color.Red}
                />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

/**
 * "2 critical, 1 high (1 known exploited)", red when anything critical or
 * high runs here. No row at all when the org has no scanner: "none" would
 * claim a scan that never happened.
 */
function VulnerabilitiesRow({
  part,
}: {
  part: Part<ResourceVulnerabilityTally | null> | undefined;
}) {
  const t = part?.ok ? part.value : undefined;
  if (t === null) return null;
  if (t && t.total > 0) {
    return (
      <List.Item.Detail.Metadata.TagList title="Vulnerabilities">
        <List.Item.Detail.Metadata.TagList.Item
          text={describeResourceVulnerabilities(t)}
          color={t.critical + t.high > 0 ? Color.Red : Color.Orange}
        />
      </List.Item.Detail.Metadata.TagList>
    );
  }
  return (
    <List.Item.Detail.Metadata.Label title="Vulnerabilities" text={partText(part, () => "None")} />
  );
}

function ServiceItem({
  client,
  service: s,
  onToggleDetail,
}: {
  client: Client;
  service: Service;
  onToggleDetail: () => void;
}) {
  const dest = destinationsFor(client, { kind: "service", orgId: client.orgId, serviceId: s.id });
  return (
    <List.Item
      icon={Icon.Layers}
      title={s.name}
      subtitle={s.tier ? SERVICE_TIER_LABELS[s.tier] : undefined}
      keywords={[s.slug, s.ownerTeam ?? ""]}
      detail={<ServiceDetail client={client} service={s} />}
      actions={
        <ActionPanel>
          <OpenActions client={client} dest={dest} />
          <Action.CopyToClipboard title="Copy Service Slug" content={s.slug} />
          <Action.CopyToClipboard title="Copy Service ID" content={s.id} />
          <Action.CopyToClipboard
            title="Copy Link"
            content={dest.web}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action.Push
            title="Declare Incident for This Service"
            icon={Icon.ExclamationMark}
            shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
            target={<ServiceIncidentForm client={client} service={s} />}
          />
          <Action
            title="Toggle Details"
            icon={Icon.Sidebar}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={onToggleDetail}
          />
        </ActionPanel>
      }
    />
  );
}

/** A service's incident affects its member resources, read when the form opens. */
function ServiceIncidentForm({ client, service }: { client: Client; service: Service }) {
  const { data, isLoading } = useCachedPromise(
    (id: string) => fetchServiceDetail(client.api, client.orgId, id),
    [service.id],
  );
  if (isLoading && !data) return <List isLoading navigationTitle="Declare Incident" />;
  const ids = (data?.members ?? []).filter((m) => !m.missing).map((m) => m.resourceId);
  return (
    <DeclareIncidentForm
      affectedResourceIds={ids.slice(0, 200)}
      affectedLabel={`${service.name} (${ids.length} resource${ids.length === 1 ? "" : "s"})`}
      defaultTitle={`${service.name}: `}
    />
  );
}

function ServiceDetail({ client, service: s }: { client: Client; service: Service }) {
  const { data, isLoading } = useCachedPromise(
    (id: string) => fetchServiceSummary(client.api, client.orgId, id),
    [s.id],
  );
  const posture = data?.findings.posture.counts;
  const open = posture ? posture.critical + posture.high + posture.medium + posture.low : 0;
  return (
    <List.Item.Detail
      isLoading={isLoading}
      markdown={s.description ? `${s.description}` : undefined}
      metadata={
        <List.Item.Detail.Metadata>
          {s.ownerTeam ? <List.Item.Detail.Metadata.Label title="Team" text={s.ownerTeam} /> : null}
          <List.Item.Detail.Metadata.Label title="Resources" text={String(s.memberCount)} />
          {data?.onCall ? (
            <List.Item.Detail.Metadata.Label
              title="On call"
              text={`${data.onCall.current?.name ?? data.onCall.current?.email ?? "Nobody"} (${data.onCall.scheduleName})`}
            />
          ) : null}
          {data?.cost.available ? (
            <List.Item.Detail.Metadata.Label
              title={`Cost (${data.cost.windowDays} days)`}
              text={data.cost.totals
                .map((t) => formatMonthlyEstimate(Math.round(t.amount * 100) / 100, t.currency))
                .join(" + ")}
            />
          ) : null}
          {data ? (
            <List.Item.Detail.Metadata.Label
              title="Posture"
              text={
                open === 0
                  ? "No open findings"
                  : `${open} open (${posture!.critical} critical, ${posture!.high} high)`
              }
            />
          ) : null}
          {data?.slos.map((slo) => (
            <List.Item.Detail.Metadata.Label
              key={slo.id}
              title={`SLO: ${slo.name}`}
              text={slo.status.replace("_", " ")}
            />
          ))}
          {s.scores.length > 0 ? (
            <List.Item.Detail.Metadata.TagList title="Scorecards">
              {s.scores.map((b) => (
                <List.Item.Detail.Metadata.TagList.Item
                  key={b.scorecardId}
                  text={`${b.scorecardName}: ${b.levelName ?? formatScorecardScore(b.score)}`}
                />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

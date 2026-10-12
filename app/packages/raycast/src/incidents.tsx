import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  fetchIncident,
  fetchIncidents,
  incidentSeverityLabel,
  incidentStatusLabel,
  type Incident,
} from "@infrawrench/client-core";
import { getClient, type Client } from "./lib/client";
import { DeclareIncidentForm } from "./lib/declare-form";
import { sortIncidents } from "./lib/format";
import { destinationsFor, openPreferred } from "./lib/open";

const SEVERITY_COLORS: Record<string, Color> = {
  sev1: Color.Red,
  sev2: Color.Orange,
  sev3: Color.Yellow,
  sev4: Color.SecondaryText,
};

export default function Command() {
  const client = getClient();
  const { data, isLoading, error, revalidate } = useCachedPromise(
    async (orgId: string) => (await fetchIncidents(client.api, orgId)).incidents,
    [client.orgId],
  );
  const incidents = sortIncidents((data ?? []).filter((i) => i.status !== "resolved"));

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={incidents.length > 0}
      searchBarPlaceholder="Filter incidents"
    >
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Couldn't load incidents"
          description={error.message}
        />
      ) : (
        <List.EmptyView
          icon={Icon.CheckCircle}
          title="No open incidents"
          actions={
            <ActionPanel>
              <Action.Push
                title="Declare Incident"
                icon={Icon.ExclamationMark}
                target={<DeclareIncidentForm />}
              />
            </ActionPanel>
          }
        />
      )}
      {incidents.map((i) => (
        <List.Item
          key={i.id}
          icon={{
            source: Icon.ExclamationMark,
            tintColor: SEVERITY_COLORS[i.severity] ?? Color.SecondaryText,
          }}
          title={i.title}
          accessories={[
            {
              tag: {
                value: incidentSeverityLabel(i.severity),
                color: SEVERITY_COLORS[i.severity] ?? Color.SecondaryText,
              },
            },
            { text: incidentStatusLabel(i.status) },
          ]}
          detail={<IncidentDetail client={client} incident={i} />}
          actions={<IncidentActions client={client} incident={i} onRefresh={revalidate} />}
        />
      ))}
    </List>
  );
}

function IncidentDetail({ client, incident }: { client: Client; incident: Incident }) {
  const { data } = useCachedPromise(
    (id: string) => fetchIncident(client.api, client.orgId, id),
    [incident.id],
  );
  const services = data?.affectedServices ?? [];
  return (
    <List.Item.Detail
      markdown={`## ${escape(incident.title)}\n\n${incident.summary ? escape(incident.summary) : "_No summary yet._"}`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Severity"
            text={incidentSeverityLabel(incident.severity)}
          />
          <List.Item.Detail.Metadata.Label
            title="Status"
            text={incidentStatusLabel(incident.status)}
          />
          <List.Item.Detail.Metadata.Label
            title="Started"
            text={new Date(incident.startedAt).toLocaleString()}
          />
          {incident.declaredByName ? (
            <List.Item.Detail.Metadata.Label title="Declared by" text={incident.declaredByName} />
          ) : null}
          <List.Item.Detail.Metadata.Label
            title="Affected resources"
            text={String(incident.affectedResourceIds.length)}
          />
          {services.length > 0 ? (
            <List.Item.Detail.Metadata.TagList title="Services">
              {services.map((s) => (
                <List.Item.Detail.Metadata.TagList.Item key={s.id} text={s.name} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : null}
          <List.Item.Detail.Metadata.Label title="Notes" text={String(incident.noteCount)} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function IncidentActions({
  client,
  incident,
  onRefresh,
}: {
  client: Client;
  incident: Incident;
  onRefresh: () => void;
}) {
  const dest = destinationsFor(client, {
    kind: "incident",
    orgId: client.orgId,
    incidentId: incident.id,
  });
  return (
    <ActionPanel>
      <Action
        title="Open Incident"
        icon={Icon.ArrowRight}
        onAction={() => void openPreferred(client, dest)}
      />
      <Action.OpenInBrowser title="Open in Web App" url={dest.web} />
      <Action.Open title="Open in Desktop App" icon={Icon.AppWindow} target={dest.desktop} />
      <Action.CopyToClipboard
        title="Copy Link"
        content={dest.web}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
      />
      <Action.CopyToClipboard title="Copy Incident ID" content={incident.id} />
      <Action.Push
        title="Declare Another Incident"
        icon={Icon.ExclamationMark}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
        target={<DeclareIncidentForm />}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={onRefresh}
      />
    </ActionPanel>
  );
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

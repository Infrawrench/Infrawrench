import { Action, ActionPanel, Icon, List, open } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fetchOnCallNow, webOnCallUrl } from "@infrawrench/client-core";
import { getClient } from "./lib/client";
import { formatHandoff } from "./lib/format";

export default function Command() {
  const client = getClient();
  const { data, isLoading, error, revalidate } = useCachedPromise(
    (orgId: string) => fetchOnCallNow(client.api, orgId),
    [client.orgId],
  );
  const rotations = [...(data?.onCall ?? [])].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.scheduleName.localeCompare(b.scheduleName),
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter rotations">
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Couldn't load on-call"
          description={error.message}
        />
      ) : (
        <List.EmptyView
          icon={Icon.Bell}
          title="No on-call rotations"
          description="Set one up under Settings > On-call."
        />
      )}
      {rotations.map((r) => {
        const who = r.shift
          ? (r.shift.name ?? r.shift.email ?? "Unknown")
          : r.enabled
            ? "Nobody"
            : "Disabled";
        return (
          <List.Item
            key={r.scheduleId}
            icon={r.shift ? Icon.Person : Icon.Moon}
            title={r.scheduleName}
            subtitle={who}
            accessories={[
              ...(r.shift?.source === "override" ? [{ tag: "Cover" }] : []),
              ...(r.shift ? [{ text: formatHandoff(r.shift.endsAt) }] : []),
              ...(r.next
                ? [
                    {
                      text: `next: ${r.next.name ?? r.next.email ?? "unknown"}`,
                      icon: Icon.ArrowRight,
                    },
                  ]
                : []),
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Open On-Call Settings"
                  icon={Icon.Globe}
                  onAction={() => void open(webOnCallUrl(client.cloudUrl, client.orgId))}
                />
                {r.shift?.email ? (
                  <Action.CopyToClipboard title="Copy Email" content={r.shift.email} />
                ) : null}
                {r.shift?.email ? (
                  <Action.OpenInBrowser
                    title="Email"
                    icon={Icon.Envelope}
                    url={`mailto:${r.shift.email}`}
                  />
                ) : null}
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={revalidate}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

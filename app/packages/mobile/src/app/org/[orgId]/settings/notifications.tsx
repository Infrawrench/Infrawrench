import { useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addSlackChannel,
  disconnectSlackWorkspace,
  getPushPreferences,
  getSlackInstallUrl,
  getSlackStatus,
  listAvailableSlackChannels,
  listPushDevices,
  removeSlackChannel,
  sendSlackTestMessage,
  unregisterPushDevice,
  updatePushPreferences,
  updateSlackChannel,
  type PushDeviceSummary,
  type PushPreferences,
  type SlackChannel,
  type SlackChannelTriggers,
  type SlackStatus,
} from "@infrawrench/client-core";
import type { CloudFetch } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/** Shape of POST /api/org/:orgId/push/test (web api/routes/push-devices.ts). */
interface TestPushResult {
  ok: boolean;
  attempted: number;
  succeeded: number;
}

export default function NotificationsScreen() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const prefsKey = ["push-preferences", orgId] as const;

  const prefs = useQuery({
    queryKey: prefsKey,
    queryFn: () => getPushPreferences(api, orgId),
  });

  const devices = useQuery({
    queryKey: ["push-devices"],
    queryFn: () => listPushDevices(api),
  });

  const updatePrefs = useMutation({
    mutationFn: (patch: Partial<PushPreferences>) => updatePushPreferences(api, orgId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: prefsKey });
      const previous = queryClient.getQueryData<PushPreferences>(prefsKey);
      if (previous) queryClient.setQueryData(prefsKey, { ...previous, ...patch });
      return { previous };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(prefsKey, ctx.previous);
      Alert.alert("Update failed", e instanceof Error ? e.message : "Unknown error");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: prefsKey }),
  });

  const removeDevice = useMutation({
    mutationFn: (deviceId: string) => unregisterPushDevice(api, deviceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["push-devices"] }),
    onError: (e) => Alert.alert("Remove failed", e instanceof Error ? e.message : "Unknown error"),
  });

  const testPush = useMutation({
    mutationFn: () => api.org<TestPushResult>(orgId, "/push/test", { method: "POST" }),
    onSuccess: (result) => {
      if (result) {
        Alert.alert("Test push", `Sent to ${result.succeeded} of ${result.attempted} device(s).`);
      } else {
        Alert.alert("Test push", "Test push sent.");
      }
    },
    onError: (e) =>
      Alert.alert("Test push failed", e instanceof Error ? e.message : "Unknown error"),
  });

  if (prefs.isLoading) return <LoadingView />;
  if (prefs.isError) {
    return (
      <ErrorView
        message={prefs.error instanceof Error ? prefs.error.message : "Failed to load"}
        onRetry={() => void prefs.refetch()}
      />
    );
  }

  const current = prefs.data ?? { syncIncidents: true, budgetAlerts: true, workflowPages: true };
  const deviceList = devices.data ?? [];

  const confirmRemove = (d: PushDeviceSummary) => {
    Alert.alert(
      "Remove device",
      `Stop sending push notifications to ${d.deviceName ?? d.platform}?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeDevice.mutate(d.id) },
      ],
    );
  };

  return (
    <Screen
      onRefresh={() => {
        void prefs.refetch();
        void devices.refetch();
      }}
      refreshing={prefs.isRefetching}
    >
      <SectionTitle>Push notifications for this org</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
              Sync incidents
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              A provider account sync starts failing.
            </Text>
          </View>
          <Switch
            value={current.syncIncidents}
            onValueChange={(v) => updatePrefs.mutate({ syncIncidents: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
              Budget alerts
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              A budget crosses an alert threshold.
            </Text>
          </View>
          <Switch
            value={current.budgetAlerts}
            onValueChange={(v) => updatePrefs.mutate({ budgetAlerts: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
              Workflow pages
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              A workflow raises an alert with infra.page().
            </Text>
          </View>
          <Switch
            value={current.workflowPages}
            onValueChange={(v) => updatePrefs.mutate({ workflowPages: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>
      </Card>

      <SectionTitle>Your devices</SectionTitle>
      <Card>
        {deviceList.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>No registered devices.</Text>
        ) : (
          deviceList.map((d) => (
            <Row
              key={d.id}
              title={d.deviceName ?? (d.platform === "ios" ? "iPhone" : "Android device")}
              subtitle={`${d.platform} · last seen ${new Date(d.lastSeenAt).toLocaleDateString()}${d.disabled ? " · disabled" : ""}`}
              right={
                <Button
                  label="Remove"
                  variant="secondary"
                  disabled={removeDevice.isPending}
                  onPress={() => confirmRemove(d)}
                />
              }
            />
          ))
        )}
      </Card>

      <Button
        label={testPush.isPending ? "Sending…" : "Send test push"}
        variant="secondary"
        disabled={testPush.isPending}
        onPress={() => testPush.mutate()}
      />

      <SlackSection api={api} orgId={orgId} />
    </Screen>
  );
}

const SLACK_TRIGGERS = [
  { key: "syncIncidents", label: "Sync failures" },
  { key: "budgetAlerts", label: "Budgets" },
  { key: "workflowPages", label: "Workflow pages" },
] as const satisfies ReadonlyArray<{ key: keyof SlackChannelTriggers; label: string }>;

/**
 * Slack routing for the whole org — unlike the push toggles above, which are
 * per-user. The install itself is an OAuth round-trip in the system browser;
 * when it closes we refetch, because the callback lands on the web app rather
 * than back in here.
 */
function SlackSection({ api, orgId }: { api: CloudFetch; orgId: string }) {
  const queryClient = useQueryClient();
  const statusKey = ["slack-status", orgId] as const;
  const [picking, setPicking] = useState(false);

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => getSlackStatus(api, orgId),
  });

  const install = status.data?.installations[0] ?? null;

  const available = useQuery({
    queryKey: ["slack-available-channels", orgId, install?.id],
    queryFn: () => listAvailableSlackChannels(api, orgId, install?.id ?? ""),
    enabled: picking && Boolean(install),
  });

  const refetchStatus = () => queryClient.invalidateQueries({ queryKey: statusKey });
  const alertError = (title: string) => (e: unknown) =>
    Alert.alert(title, e instanceof Error ? e.message : "Unknown error");

  const connect = useMutation({
    mutationFn: async () => {
      const url = await getSlackInstallUrl(api, orgId);
      if (!url) throw new Error("Slack is not configured on this server");
      await WebBrowser.openBrowserAsync(url);
    },
    onSuccess: () => void refetchStatus(),
    onError: alertError("Slack install failed"),
  });

  const disconnect = useMutation({
    mutationFn: (installationId: string) => disconnectSlackWorkspace(api, orgId, installationId),
    onSuccess: () => void refetchStatus(),
    onError: alertError("Disconnect failed"),
  });

  const toggle = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SlackChannelTriggers> }) =>
      updateSlackChannel(api, orgId, id, patch),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: statusKey });
      const previous = queryClient.getQueryData<SlackStatus>(statusKey);
      if (previous) {
        queryClient.setQueryData<SlackStatus>(statusKey, {
          ...previous,
          channels: previous.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        });
      }
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(statusKey, ctx.previous);
      alertError("Update failed")(e);
    },
    onSettled: () => void refetchStatus(),
  });

  const addChannel = useMutation({
    mutationFn: (channel: { id: string; name: string; isPrivate: boolean }) =>
      addSlackChannel(api, orgId, {
        installationId: install?.id ?? "",
        channelId: channel.id,
        channelName: channel.name,
        isPrivate: channel.isPrivate,
      }),
    onSuccess: () => {
      setPicking(false);
      void refetchStatus();
    },
    onError: alertError("Add channel failed"),
  });

  const removeChannel = useMutation({
    mutationFn: (id: string) => removeSlackChannel(api, orgId, id),
    onSuccess: () => void refetchStatus(),
    onError: alertError("Remove failed"),
  });

  const test = useMutation({
    mutationFn: () => sendSlackTestMessage(api, orgId),
    onSuccess: (result) =>
      Alert.alert(
        "Slack test",
        result
          ? `Posted to ${result.succeeded} of ${result.channelCount} channel(s).`
          : "Test message sent.",
      ),
    onError: alertError("Slack test failed"),
  });

  if (status.isLoading || !status.data) return null;

  if (!status.data.configured) {
    return (
      <>
        <SectionTitle>Slack</SectionTitle>
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Slack isn&apos;t set up on this server.
          </Text>
        </Card>
      </>
    );
  }

  if (!install) {
    return (
      <>
        <SectionTitle>Slack</SectionTitle>
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Connect a workspace to send alerts to Slack channels.
          </Text>
          <Button
            label={connect.isPending ? "Opening Slack…" : "Add to Slack"}
            variant="secondary"
            disabled={connect.isPending}
            onPress={() => connect.mutate()}
          />
        </Card>
      </>
    );
  }

  const channels = status.data.channels;
  const alreadyRouted = new Set(channels.map((c) => c.channelId));
  const options = (available.data ?? []).filter((c) => !alreadyRouted.has(c.id));

  return (
    <>
      <SectionTitle>Slack</SectionTitle>
      <Card>
        <Row
          title={install.teamName ?? install.teamId}
          subtitle="Connected workspace"
          right={
            <Button
              label="Disconnect"
              variant="secondary"
              disabled={disconnect.isPending}
              onPress={() =>
                Alert.alert(
                  "Disconnect Slack",
                  `Stop sending alerts to ${install.teamName ?? install.teamId}?`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => disconnect.mutate(install.id),
                    },
                  ],
                )
              }
            />
          }
        />

        {channels.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            No channels yet. Add one to start receiving alerts.
          </Text>
        ) : (
          channels.map((ch) => (
            <SlackChannelRow
              key={ch.id}
              channel={ch}
              onToggle={(patch) => toggle.mutate({ id: ch.id, patch })}
              onRemove={() => removeChannel.mutate(ch.id)}
            />
          ))
        )}
      </Card>

      {picking ? (
        <Card>
          {available.isLoading ? (
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading channels…</Text>
          ) : available.isError ? (
            <Text style={{ color: colors.danger, fontSize: 13 }}>
              {available.error instanceof Error ? available.error.message : "Failed to load"}
            </Text>
          ) : options.length === 0 ? (
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>
              Every channel the app can see is already routed here.
            </Text>
          ) : (
            options.map((c) => (
              <Row
                key={c.id}
                title={`#${c.name}`}
                subtitle={c.isPrivate ? "private" : undefined}
                right={
                  <Button
                    label="Add"
                    variant="secondary"
                    disabled={addChannel.isPending}
                    onPress={() =>
                      addChannel.mutate({ id: c.id, name: c.name, isPrivate: c.isPrivate })
                    }
                  />
                }
              />
            ))
          )}
          <Button label="Cancel" variant="secondary" onPress={() => setPicking(false)} />
        </Card>
      ) : (
        <Button label="Add a channel" variant="secondary" onPress={() => setPicking(true)} />
      )}

      <Text style={{ color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.md }}>
        Public channels work as soon as you add them. Invite the Infrawrench app to a private
        channel in Slack before adding it.
      </Text>

      <Button
        label={test.isPending ? "Posting…" : "Send test message"}
        variant="secondary"
        disabled={test.isPending || channels.length === 0}
        onPress={() => test.mutate()}
      />
    </>
  );
}

function SlackChannelRow({
  channel,
  onToggle,
  onRemove,
}: {
  channel: SlackChannel;
  onToggle: (patch: Partial<SlackChannelTriggers>) => void;
  onRemove: () => void;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Row
        title={`#${channel.channelName}`}
        subtitle={channel.isPrivate ? "private" : undefined}
        right={<Button label="Remove" variant="secondary" onPress={onRemove} />}
      />
      {SLACK_TRIGGERS.map((t) => (
        <View
          key={t.key}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
            paddingLeft: spacing.md,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 13, flex: 1 }}>{t.label}</Text>
          <Switch
            value={channel[t.key]}
            onValueChange={(v) => onToggle({ [t.key]: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>
      ))}
    </View>
  );
}

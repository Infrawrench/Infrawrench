import { useState } from "react";
import { Alert, StyleSheet, Switch, Text, TextInput, View } from "react-native";
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
  addMsTeamsWebhook,
  getMsTeamsStatus,
  removeMsTeamsWebhook,
  sendMsTeamsTestMessage,
  getDigestSettings,
  listDigestRecipients,
  sendDigestNow,
  updateDigestSettings,
  DEFAULT_MUTED_TRIGGERS,
  PUSHABLE_TRIGGERS,
  alertTriggerDef,
  pushTriggerEnabled,
  withPushTrigger,
  type PushDeviceSummary,
  type PushPreferences,
  type SlackChannel,
  type SlackStatus,
  type MsTeamsStatus,
  type MsTeamsWebhook,
  type DigestSettings,
  type DigestSettingsPatch,
} from "@infrawrench/client-core";
import type { CloudFetch } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Button,
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Separator,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

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

  const current: PushPreferences = prefs.data ?? {
    // "No row means the shipped defaults", which is not the same as "nothing
    // muted" — drift is a continuous feed where the others are exceptional.
    mutedTriggers: [...DEFAULT_MUTED_TRIGGERS],
  };
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
        {/*
          Driven by the shared trigger registry rather than eleven hand-written
          rows. A release that adds a trigger gets a row here for free — which
          is the point of the routing refactor: the trigger list lives in one
          place instead of being spelled out in every surface that shows it.
        */}
        {PUSHABLE_TRIGGERS.map((trigger) => {
          const def = alertTriggerDef(trigger);
          return (
            <View
              key={trigger}
              style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
                  {def.label}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>{def.description}</Text>
              </View>
              <Switch
                value={pushTriggerEnabled(current, trigger)}
                onValueChange={(v) =>
                  updatePrefs.mutate({ mutedTriggers: withPushTrigger(current, trigger, v) })
                }
                trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
              />
            </View>
          );
        })}
      </Card>

      <SectionTitle>Your devices</SectionTitle>
      <Card list>
        {deviceList.length === 0 ? (
          <EmptyView message="No registered devices." />
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

      <MsTeamsSection api={api} orgId={orgId} />

      <WeeklyDigestSection api={api} orgId={orgId} />
    </Screen>
  );
}

/** ISO day numbers, as the digest API expresses them (1 = Monday). */
const DIGEST_DAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

function digestScheduleLine(settings: DigestSettings): string {
  const day = DIGEST_DAY_LABELS[settings.sendDay - 1] ?? "Monday";
  const hour = `${String(settings.sendHour).padStart(2, "0")}:00`;
  return `Sends every ${day} at ${hour} ${settings.timezone}, covering the last complete Monday-to-Sunday week.`;
}

/**
 * The outcome of the last delivery attempt, as a colour and a headline. This
 * is the part of the digest that has to be on the phone: the digest is sent by
 * a background poller, so without a surface for its failures a digest that
 * quietly stopped arriving looks exactly like a quiet week.
 */
function digestStatusView(settings: DigestSettings): { color: string; headline: string } | null {
  switch (settings.lastStatus) {
    case "succeeded":
      return { color: colors.success, headline: "Last digest delivered to every destination." };
    case "partial":
      return { color: colors.warning, headline: "Last digest only partly delivered." };
    case "failed":
      return { color: colors.danger, headline: "Last digest failed to send." };
    case "no_targets":
      return { color: colors.warning, headline: "The digest has nowhere to go." };
    case "pending":
      return { color: colors.textMuted, headline: "A digest is being sent…" };
    default:
      return null;
  }
}

/**
 * The weekly digest's org-level settings, as much of them as belongs on a
 * phone: the on/off switch, the AI-narrative opt-in, Send now, and — the
 * reason this section is more than a toggle — the status of the last delivery
 * attempt, mirroring web's `WeeklyDigestSection`.
 *
 * Deliberately read-only here (see KNOWLEDGE.md's mobile omissions):
 * - the **schedule** (day / hour / time zone) is shown as a sentence rather
 *   than three pickers. Day and hour are easy enough, but the zone list is the
 *   browser's whole tz database — a searchable ~600-row picker — and shipping
 *   two thirds of a schedule editor is worse than none.
 * - the **email recipient list** is shown, not edited. It is an org-wide
 *   distribution list (a `finance@` alias, not a member opt-in), which is
 *   admin configuration rather than something you retune from a phone.
 *
 * The whole section 403s for anyone without `org:settings:write` — the query
 * simply fails and this renders nothing, the same shape as the Slack section.
 */
function WeeklyDigestSection({ api, orgId }: { api: CloudFetch; orgId: string }) {
  const queryClient = useQueryClient();
  const settingsKey = ["digest-settings", orgId] as const;

  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => getDigestSettings(api, orgId),
  });

  const recipients = useQuery({
    queryKey: ["digest-recipients", orgId],
    queryFn: () => listDigestRecipients(api, orgId),
    // Same permission as the settings themselves; don't ask until they load.
    enabled: settings.isSuccess,
  });

  const update = useMutation({
    mutationFn: (patch: DigestSettingsPatch) => updateDigestSettings(api, orgId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKey });
      const previous = queryClient.getQueryData<DigestSettings>(settingsKey);
      if (previous) queryClient.setQueryData(settingsKey, { ...previous, ...patch });
      return { previous };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(settingsKey, ctx.previous);
      Alert.alert("Update failed", e instanceof Error ? e.message : "Unknown error");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });

  const sendNow = useMutation({
    mutationFn: () => sendDigestNow(api, orgId),
    onSuccess: (result) => {
      Alert.alert(
        "Weekly digest",
        result
          ? `Sent to ${result.succeeded} of ${result.attempted} destination(s) — Slack ${result.slack.succeeded}/${result.slack.attempted}, Teams ${result.teams.succeeded}/${result.teams.attempted}, email ${result.email.succeeded}/${result.email.attempted}.`
          : "Digest sent.",
      );
      void queryClient.invalidateQueries({ queryKey: settingsKey });
    },
    onError: (e) => Alert.alert("Send failed", e instanceof Error ? e.message : "Unknown error"),
  });

  if (settings.isLoading || !settings.data) return null;

  const current = settings.data;
  const status = digestStatusView(current);
  const recipientList = recipients.data ?? [];

  return (
    <>
      <SectionTitle>Weekly digest</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
              Send a weekly digest
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              Last week&apos;s spend with week-over-week movers, sync incidents, and resource churn
              — to the channels with &quot;Weekly digest&quot; on, plus the email recipients below.
            </Text>
          </View>
          <Switch
            value={current.enabled}
            onValueChange={(v) => update.mutate({ enabled: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>

        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {digestScheduleLine(current)} Change the schedule from the web app.
        </Text>

        <Separator />

        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
              AI summary paragraph
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              {current.narrativeAvailable
                ? "A short paragraph above the numbers saying what changed and why it stands out. Only the digest's own figures are sent to the model — never resource or credential data."
                : "Unavailable: this deployment has no LLM API key configured."}
            </Text>
          </View>
          <Switch
            value={current.narrativeEnabled}
            disabled={!current.narrativeAvailable}
            onValueChange={(v) => update.mutate({ narrativeEnabled: v })}
            trackColor={{ false: colors.surfaceOverlay, true: colors.accent }}
          />
        </View>
      </Card>

      <Card>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: "500" }}>
          Email recipients
        </Text>
        {!current.emailAvailable ? (
          <Text style={{ color: colors.warning, fontSize: 12 }}>
            This deployment has no mail provider configured, so email recipients receive nothing.
          </Text>
        ) : null}
        {recipientList.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            No email recipients. Add addresses from the web app — they don&apos;t have to belong to
            Infrawrench users.
          </Text>
        ) : (
          <>
            {recipientList.map((r) => (
              <Text key={r.id} style={{ color: colors.textSecondary, fontSize: 13 }}>
                {r.email}
              </Text>
            ))}
            <Text style={{ color: colors.textFaint, fontSize: 11 }}>Managed from the web app.</Text>
          </>
        )}
      </Card>

      <Card>
        {status ? (
          <>
            <Text style={{ color: status.color, fontSize: 13, fontWeight: "500" }}>
              {status.headline}
            </Text>
            {current.lastError ? (
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{current.lastError}</Text>
            ) : null}
            <Text style={{ color: colors.textFaint, fontSize: 11 }}>
              {current.lastAttemptAt
                ? `Last attempt ${new Date(current.lastAttemptAt).toLocaleString()} (attempt ${current.attemptCount})`
                : "No attempt yet"}
              {current.lastSentWeekStart ? ` · week of ${current.lastSentWeekStart}` : ""}
              {current.nextAttemptAt
                ? ` · retrying ${new Date(current.nextAttemptAt).toLocaleString()}`
                : ""}
              .
            </Text>
          </>
        ) : (
          <Text style={{ color: colors.textFaint, fontSize: 11 }}>
            {current.lastSentAt
              ? `Last sent ${new Date(current.lastSentAt).toLocaleString()}${
                  current.lastSentWeekStart ? ` (week of ${current.lastSentWeekStart})` : ""
                }.`
              : "No digest sent yet."}
          </Text>
        )}
      </Card>

      <Button
        label={sendNow.isPending ? "Sending…" : "Send now"}
        variant="secondary"
        disabled={sendNow.isPending}
        onPress={() => sendNow.mutate()}
      />
    </>
  );
}

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
        <Separator />

        {channels.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            No channels yet. Add one to start receiving alerts.
          </Text>
        ) : (
          channels.map((ch) => (
            <SlackChannelRow
              key={ch.id}
              channel={ch}
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
            <RowGroup>
              {options.map((c) => (
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
              ))}
            </RowGroup>
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

/**
 * A connected channel, with no per-trigger switches.
 *
 * Which alerts reach a channel is an org-wide routing rule now
 * (`org:settings:write`), and the rules editor is a web/desktop surface — the
 * same demotion drift-alert settings and the digest schedule already carry
 * here. What the phone keeps is the part that is genuinely per-device: your own
 * push mutes, above.
 */
function SlackChannelRow({ channel, onRemove }: { channel: SlackChannel; onRemove: () => void }) {
  return (
    <Row
      title={`#${channel.channelName}`}
      subtitle={channel.isPrivate ? "private" : undefined}
      right={<Button label="Remove" variant="secondary" onPress={onRemove} />}
    />
  );
}

/**
 * Microsoft Teams routing for the whole org. There is no "Add to Teams" button
 * because Teams has no app-only install flow for posting channel messages — a
 * channel is identified by the webhook URL of a Teams "Workflows" automation,
 * which the user creates in Teams and pastes here. See the web settings page
 * and `server-core/src/msteams.ts` for the full reasoning.
 */
function MsTeamsSection({ api, orgId }: { api: CloudFetch; orgId: string }) {
  const queryClient = useQueryClient();
  const statusKey = ["msteams-status", orgId] as const;
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => getMsTeamsStatus(api, orgId),
  });

  const refetchStatus = () => queryClient.invalidateQueries({ queryKey: statusKey });
  const alertError = (title: string) => (e: unknown) =>
    Alert.alert(title, e instanceof Error ? e.message : "Unknown error");

  const add = useMutation({
    mutationFn: () => addMsTeamsWebhook(api, orgId, { label, url }),
    onSuccess: () => {
      setAdding(false);
      setLabel("");
      setUrl("");
      void refetchStatus();
    },
    onError: alertError("Add channel failed"),
  });

  const removeWebhook = useMutation({
    mutationFn: (id: string) => removeMsTeamsWebhook(api, orgId, id),
    onSuccess: () => void refetchStatus(),
    onError: alertError("Remove failed"),
  });

  const test = useMutation({
    mutationFn: () => sendMsTeamsTestMessage(api, orgId),
    onSuccess: (result) =>
      Alert.alert(
        "Teams test",
        result
          ? `Posted to ${result.succeeded} of ${result.webhookCount} channel(s).`
          : "Test message sent.",
      ),
    onError: alertError("Teams test failed"),
  });

  if (status.isLoading || !status.data) return null;

  const webhooks = status.data.webhooks;

  return (
    <>
      <SectionTitle>Microsoft Teams</SectionTitle>
      <Card>
        {webhooks.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            No channels yet. Add one to start receiving alerts.
          </Text>
        ) : (
          webhooks.map((w) => (
            <MsTeamsWebhookRow key={w.id} webhook={w} onRemove={() => removeWebhook.mutate(w.id)} />
          ))
        )}
      </Card>

      {adding ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            In Teams, open the channel&apos;s More options (…) → Workflows, pick &quot;Post to a
            channel when a webhook request is received&quot;, then paste the URL it gives you.
          </Text>
          <TextInput
            style={msTeamsStyles.input}
            value={label}
            onChangeText={setLabel}
            placeholder="Label, e.g. #alerts (Platform)"
            placeholderTextColor={colors.textFaint}
          />
          <TextInput
            style={msTeamsStyles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="Webhook URL"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Button
            label={add.isPending ? "Adding…" : "Add channel"}
            variant="secondary"
            disabled={add.isPending || !label.trim() || !url.trim()}
            onPress={() => add.mutate()}
          />
          <Button label="Cancel" variant="secondary" onPress={() => setAdding(false)} />
        </Card>
      ) : (
        <Button label="Add a channel" variant="secondary" onPress={() => setAdding(true)} />
      )}

      <Text style={{ color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.md }}>
        The webhook URL is a credential — anyone holding it can post to that channel. It&apos;s
        stored encrypted and never shown again after you add it.
      </Text>

      <Button
        label={test.isPending ? "Posting…" : "Send test message"}
        variant="secondary"
        disabled={test.isPending || webhooks.length === 0}
        onPress={() => test.mutate()}
      />
    </>
  );
}

/** A connected Teams channel. Routing is a web/desktop surface — see `SlackChannelRow`. */
function MsTeamsWebhookRow({
  webhook,
  onRemove,
}: {
  webhook: MsTeamsWebhook;
  onRemove: () => void;
}) {
  return (
    <Row
      title={webhook.label}
      subtitle={webhook.urlHint}
      right={<Button label="Remove" variant="secondary" onPress={onRemove} />}
    />
  );
}

const msTeamsStyles = StyleSheet.create({
  input: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 15,
  },
});

import { Alert, Switch, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPushPreferences,
  listPushDevices,
  unregisterPushDevice,
  updatePushPreferences,
  type PushDeviceSummary,
  type PushPreferences,
} from "@infrawrench/client-core";
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
    </Screen>
  );
}

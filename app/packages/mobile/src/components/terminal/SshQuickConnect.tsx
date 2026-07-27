import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { deriveSSHUsername, pickQuickConnectKeyId, type SshKey } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, ErrorView, LoadingView, SectionTitle } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Mobile counterpart of the web SshQuickConnectPanel: resources that expose an
 * `sshEndpoint` (droplets, EC2, Hetzner servers …) have no plugin-native SSH
 * credentials, so the operator pairs the resolved host with an org SSH key and
 * a username before we send `ssh:open`. Without those fields the proxy falls
 * back to the plugin config and rejects the session with "Plugin does not
 * support SSH".
 */
export function SshQuickConnect({
  host,
  defaultUsername,
  onConnect,
}: {
  host: string;
  defaultUsername?: string | undefined;
  onConnect: (config: { sshKeyId: string; username: string }) => void;
}) {
  const { api, orgId } = useOrgApi();
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [username, setUsername] = useState(defaultUsername || "root");

  const keysQuery = useQuery({
    queryKey: ["ssh-keys", orgId],
    queryFn: () => api.org<SshKey[]>(orgId, "/ssh-keys"),
  });

  const keys = useMemo(() => keysQuery.data ?? [], [keysQuery.data]);

  useEffect(() => {
    if (keys.length === 0) return;
    const effectiveUsername = defaultUsername || "root";
    setSelectedKeyId((prev) =>
      pickQuickConnectKeyId({ keys, previousId: prev, effectiveUsername }),
    );
    // Only guess a username when the resource type didn't declare one.
    if (!defaultUsername) {
      const matchByUsername = keys.find(
        (k) => k.name.toLowerCase() === effectiveUsername.toLowerCase(),
      );
      const owner = keys[0]!.ownerName;
      if (!matchByUsername && owner) {
        const derived = deriveSSHUsername(owner);
        setUsername((prev) => (prev === "root" ? derived : prev));
      }
    }
  }, [keys, defaultUsername]);

  if (keysQuery.isLoading) return <LoadingView />;
  if (keysQuery.isError) {
    return (
      <ErrorView
        message={
          keysQuery.error instanceof Error ? keysQuery.error.message : "Failed to load SSH keys"
        }
        onRetry={() => void keysQuery.refetch()}
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
      keyboardShouldPersistTaps="handled"
    >
      <Card>
        <SectionTitle>Connect</SectionTitle>
        <Text style={styles.host}>{host}</Text>

        <Text style={styles.label}>Username</Text>
        <TextInput
          value={username}
          onChangeText={(next) => {
            setUsername(next);
            const match = keys.find((k) => k.name.toLowerCase() === next.toLowerCase());
            if (match) setSelectedKeyId(match.id);
          }}
          placeholder="root"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />

        <Text style={styles.label}>SSH key</Text>
        {keys.length === 0 ? (
          <Text style={styles.empty}>
            No SSH keys in this organization. Create one in the web or desktop app first.
          </Text>
        ) : (
          <View style={styles.keyList}>
            {keys.map((k) => {
              const selected = k.id === selectedKeyId;
              return (
                <Pressable
                  key={k.id}
                  onPress={() => {
                    setSelectedKeyId(k.id);
                    if (!defaultUsername && k.ownerName) {
                      const derived = deriveSSHUsername(k.ownerName);
                      setUsername((prev) => (prev === "root" || prev === derived ? derived : prev));
                    }
                  }}
                  style={[styles.keyRow, selected && styles.keyRowSelected]}
                >
                  <Text style={styles.keyName}>{k.name}</Text>
                  <Text style={styles.keyMeta}>
                    {[k.ownerName, k.keyType].filter(Boolean).join(" · ")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Button
          label="Connect"
          disabled={!selectedKeyId || !username.trim()}
          onPress={() => {
            if (!selectedKeyId) return;
            onConnect({ sshKeyId: selectedKeyId, username: username.trim() });
          }}
        />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  host: { color: colors.textMuted, fontFamily: "monospace", fontSize: 12 },
  label: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 13,
    padding: spacing.sm,
  },
  empty: { color: colors.textFaint, fontSize: 12 },
  keyList: { gap: spacing.xs },
  keyRow: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  keyRowSelected: { borderColor: colors.accent },
  keyName: { color: colors.text, fontSize: 14 },
  keyMeta: { color: colors.textMuted, fontSize: 11 },
});

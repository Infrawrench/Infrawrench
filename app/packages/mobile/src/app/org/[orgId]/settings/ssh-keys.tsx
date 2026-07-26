import { Alert, Pressable, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors } from "@/lib/theme";

/** Shape of GET /api/org/:orgId/ssh-keys (web api/routes/ssh-keys.ts). */
interface SshKey {
  id: string;
  name: string;
  keyType: string;
  isImported: boolean;
  fingerprint: string;
  publicKey: string;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  createdAt: string;
}

export default function SshKeysScreen() {
  const { api, orgId } = useOrgApi();

  const keys = useQuery({
    queryKey: ["ssh-keys", orgId],
    queryFn: () => api.org<SshKey[]>(orgId, "/ssh-keys"),
  });

  if (keys.isLoading) return <LoadingView />;
  if (keys.isError) {
    return (
      <ErrorView
        message={keys.error instanceof Error ? keys.error.message : "Failed to load"}
        onRetry={() => void keys.refetch()}
      />
    );
  }

  const list = keys.data ?? [];
  if (list.length === 0) {
    return <EmptyView message="No SSH keys in this organization yet." />;
  }

  const copyKey = (key: SshKey) => {
    void Clipboard.setStringAsync(key.publicKey);
    Alert.alert("Copied", `Public key for "${key.name}" copied to clipboard.`);
  };

  return (
    <Screen onRefresh={() => void keys.refetch()} refreshing={keys.isRefetching}>
      <Card list>
        {list.map((k) => (
          <Pressable key={k.id} onLongPress={() => copyKey(k)}>
            <Row
              title={k.name}
              subtitle={`${k.fingerprint} · ${k.keyType}${k.isImported ? " · imported" : ""} · ${k.ownerName}`}
            />
          </Pressable>
        ))}
      </Card>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        Long-press a key to copy its public key. Keys are managed on the web or desktop app.
      </Text>
    </Screen>
  );
}

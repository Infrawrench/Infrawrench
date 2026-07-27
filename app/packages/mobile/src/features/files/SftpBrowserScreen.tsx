import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { SshQuickConnect } from "@/components/terminal/SshQuickConnect";
import { colors } from "@/lib/theme";

/**
 * SFTP file browser over the cloud HTTP endpoints (`/sftp/list` via
 * connection-features, `/v1/sftp/download|upload`). Downloads land in the
 * app cache and open the share sheet; uploads go through the document picker.
 *
 * Resources that expose an `sshEndpoint` rather than plugin-native SSH
 * credentials (droplets, EC2, Hetzner servers …) go through the same
 * quick-connect step as the terminal: every request carries the chosen org key
 * plus host/username, since `resolveSshConfig` otherwise has nothing to dial.
 */

interface SftpEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Managed-key parameters for an `sshEndpoint` resource, once the key is chosen. */
interface DirectSsh {
  sshKeyId: string;
  sshHost: string;
  sshUsername: string;
}

export function SftpBrowserScreen({
  accountId,
  sshHost,
  defaultSshUsername,
}: {
  accountId: string;
  sshHost?: string | undefined;
  defaultSshUsername?: string | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const [path, setPath] = useState("/");
  const [busy, setBusy] = useState<string | null>(null);
  const [directSsh, setDirectSsh] = useState<DirectSsh | null>(null);

  const needsKey = !!sshHost && !directSsh;

  const listing = useQuery({
    queryKey: ["sftp", orgId, accountId, path, directSsh?.sshKeyId ?? null],
    enabled: !needsKey,
    queryFn: () =>
      api.org<SftpEntry[]>(orgId, "/sftp/list", {
        method: "POST",
        body: JSON.stringify({ accountId, path, ...(directSsh ?? {}) }),
      }),
  });

  async function download(entry: SftpEntry) {
    setBusy(entry.key);
    try {
      const params = new URLSearchParams({
        accountId,
        paths: JSON.stringify([entry.key]),
        ...(directSsh ?? {}),
      });
      const res = await api.raw(
        `/api/org/${encodeURIComponent(orgId)}/v1/sftp/download?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const bytes = await res.arrayBuffer();
      const file = new File(Paths.cache, entry.name);
      if (file.exists) file.delete();
      file.write(new Uint8Array(bytes));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri);
      } else {
        Alert.alert("Downloaded", `Saved to ${file.uri}`);
      }
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("accountId", accountId);
      form.append("path", path.endsWith("/") ? `${path}${asset.name}` : `${path}/${asset.name}`);
      if (directSsh) {
        form.append("sshKeyId", directSsh.sshKeyId);
        form.append("sshHost", directSsh.sshHost);
        form.append("sshUsername", directSsh.sshUsername);
      }
      form.append("file", {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? "application/octet-stream",
      } as unknown as Blob);
      const res = await api.raw(`/api/org/${encodeURIComponent(orgId)}/v1/sftp/upload`, {
        method: "POST",
        body: form as unknown as BodyInit,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
      await listing.refetch();
    } catch (e) {
      Alert.alert("Upload failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (sshHost && !directSsh) {
    return (
      <SshQuickConnect
        host={sshHost}
        defaultUsername={defaultSshUsername}
        onConnect={({ sshKeyId, username }) =>
          setDirectSsh({ sshKeyId, sshHost, sshUsername: username })
        }
      />
    );
  }

  if (listing.isLoading) return <LoadingView />;
  if (listing.isError) {
    return (
      <ErrorView
        message={listing.error instanceof Error ? listing.error.message : "SFTP listing failed"}
        onRetry={() => void listing.refetch()}
      />
    );
  }

  const entries = listing.data ?? [];
  const parent =
    path === "/" ? null : path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <Screen onRefresh={() => void listing.refetch()} refreshing={listing.isRefetching}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: colors.textMuted, fontFamily: "monospace", fontSize: 12, flex: 1 }}>
          {path}
        </Text>
        <Button
          label={busy === "upload" ? "Uploading…" : "Upload"}
          variant="secondary"
          disabled={busy !== null}
          onPress={() => void upload()}
        />
      </View>
      <Card>
        {parent !== null && <Row title=".." onPress={() => setPath(parent)} />}
        {entries.length === 0 && parent === null ? (
          <EmptyView message="Empty directory." />
        ) : (
          entries.map((entry) => (
            <Row
              key={entry.key}
              title={entry.isDirectory ? `${entry.name}/` : entry.name}
              subtitle={
                entry.isDirectory
                  ? undefined
                  : `${formatSize(entry.size)} · ${new Date(entry.lastModified).toLocaleDateString()}`
              }
              right={
                !entry.isDirectory ? (
                  <Button
                    label={busy === entry.key ? "…" : "Get"}
                    variant="secondary"
                    disabled={busy !== null}
                    onPress={() => void download(entry)}
                  />
                ) : undefined
              }
              onPress={entry.isDirectory ? () => setPath(entry.key) : undefined}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}

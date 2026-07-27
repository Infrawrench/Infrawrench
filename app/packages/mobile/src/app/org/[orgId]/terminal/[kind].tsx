import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { trustPayloadFromFrame, type ServerFrame } from "@infrawrench/client-core";
import { requestHostKeyTrust } from "@/lib/ssh/host-key-trust";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { WsSession } from "@/lib/ws/WsSession";
import {
  TerminalKeyBar,
  TerminalWebView,
  type TerminalWebViewHandle,
} from "@/components/terminal/TerminalWebView";
import { SqlConsole } from "@/components/terminal/SqlConsole";
import { SshQuickConnect } from "@/components/terminal/SshQuickConnect";
import { Button, ErrorView } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, spacing } from "@/lib/theme";

/**
 * Full-screen interactive session, routed as `/org/:orgId/terminal/:kind` where
 * kind is "ssh" | "sql" | "k8s-exec". Everything the session needs rides in the
 * query string rather than a packed path segment — resource ids routinely
 * contain the characters any delimiter would use, and `encodeURIComponent`
 * leaves most of them untouched.
 *
 * SSH sessions also carry `sshHost` / `sshUsername` when the resource type
 * declares an `sshEndpoint` (droplets, EC2, Hetzner servers …). Those resources
 * have no plugin-native SSH credentials, so we gate the pty on a quick-connect
 * step that picks an org SSH key — see SshQuickConnect.
 */

export default function TerminalScreen() {
  const router = useRouter();
  const {
    kind,
    accountId,
    resourceId,
    resourceTypeId,
    sshHost,
    sshUsername,
    peerPluginId,
    podName,
    namespace,
    containerName,
  } = useLocalSearchParams<{
    kind: string;
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sshHost?: string;
    sshUsername?: string;
    peerPluginId?: string;
    podName?: string;
    namespace?: string;
    containerName?: string;
  }>();

  if (!kind || !accountId) return <ErrorView message="Invalid terminal session link." />;

  if (kind === "ssh") {
    if (!resourceId) return <ErrorView message="Invalid terminal session link." />;
    return (
      <SshSession
        accountId={accountId}
        resourceId={resourceId}
        sshHost={sshHost}
        defaultUsername={sshUsername}
      />
    );
  }
  if (kind === "sql") {
    return (
      <SqlConsole accountId={accountId} resourceId={resourceId} resourceTypeId={resourceTypeId} />
    );
  }
  if (kind === "k8s-exec") {
    // `resourceId` is the cluster the pod lives in — the server resolves its
    // kubeconfig through the peer integration named by `peerPluginId`.
    if (!resourceId || !peerPluginId || !podName) {
      return (
        <View style={styles.center}>
          <Text style={styles.centerText}>
            This exec link is missing the pod it should attach to. Open the pod from the cluster's
            integration tab.
          </Text>
          <Button label="Go back" variant="secondary" onPress={() => router.back()} />
        </View>
      );
    }
    return (
      <K8sExecSession
        accountId={accountId}
        resourceId={resourceId}
        peerPluginId={peerPluginId}
        podName={podName}
        namespace={namespace}
        containerName={containerName}
      />
    );
  }
  return <ErrorView message={`Unknown terminal type "${kind}".`} />;
}

/** Managed-key parameters for an `sshEndpoint` resource, once the key is chosen. */
interface DirectSsh {
  sshKeyId: string;
  sshHost: string;
  sshUsername: string;
}

/**
 * Gate the pty on the quick-connect step when the resource needs a managed key.
 * The socket is only dialed once we have everything the `ssh:open` frame needs,
 * so a slow key choice can't idle out a live WebSocket.
 */
function SshSession({
  accountId,
  resourceId,
  sshHost,
  defaultUsername,
}: {
  accountId: string;
  resourceId: string;
  sshHost?: string | undefined;
  defaultUsername?: string | undefined;
}) {
  const [directSsh, setDirectSsh] = useState<DirectSsh | null>(null);
  const openFrame = useMemo(
    () => ({ type: "ssh:open", accountId, resourceId, ...(directSsh ?? {}) }),
    [accountId, resourceId, directSsh],
  );

  if (sshHost && !directSsh) {
    return (
      <SshQuickConnect
        host={sshHost}
        defaultUsername={defaultUsername}
        onConnect={({ sshKeyId, username }) =>
          setDirectSsh({ sshKeyId, sshHost, sshUsername: username })
        }
      />
    );
  }

  return <PtyTerminal protocol="ssh" openFrame={openFrame} />;
}

/** `kubectl exec` into a pod surfaced by a cluster's Kubernetes peer pane. */
function K8sExecSession({
  accountId,
  resourceId,
  peerPluginId,
  podName,
  namespace,
  containerName,
}: {
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  podName: string;
  namespace?: string | undefined;
  containerName?: string | undefined;
}) {
  const openFrame = useMemo(
    () => ({
      type: "k8s:exec:open",
      accountId,
      resourceId,
      peerPluginId,
      podName,
      ...(namespace ? { namespace } : {}),
      ...(containerName ? { containerName } : {}),
    }),
    [accountId, resourceId, peerPluginId, podName, namespace, containerName],
  );
  return <PtyTerminal protocol="k8s:exec" openFrame={openFrame} />;
}

/**
 * A pty over the WS gateway. Both protocols speak the same four frames under
 * their own prefix — `:data`, `:connected`, `:closed`, `:error` — so SSH and
 * `kubectl exec` share this component; only the opening frame differs.
 */
function PtyTerminal({
  protocol,
  openFrame,
}: {
  protocol: "ssh" | "k8s:exec";
  openFrame: Record<string, unknown>;
}) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const termRef = useRef<TerminalWebViewHandle>(null);
  const sessionRef = useRef<WsSession | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const openSentRef = useRef(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [webviewReady, setWebviewReady] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [overlay, setOverlay] = useState<{ title: string; message?: string } | null>(null);
  // Bumped after the operator pins a host key: ws tokens are single-use and
  // the proxy tears the session down when the verifier rejects, so continuing
  // means a brand new socket rather than a retry on this one.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Re-entry (api/orgId change, or a reconnect after trusting a host key)
    // builds a fresh session — reset the handshake state so the new socket
    // sends its own open frame.
    setWsConnected(false);
    setConnecting(true);
    setOverlay(null);
    openSentRef.current = false;
    const session = new WsSession({ api, orgId });
    sessionRef.current = session;
    let disposed = false;

    const offFrame = session.onFrame((frame: ServerFrame) => {
      if (disposed) return;
      switch (frame.type) {
        case `${protocol}:data`: {
          const data = (frame as { data?: unknown }).data;
          if (typeof data === "string") termRef.current?.write(data);
          setConnecting(false);
          break;
        }
        case `${protocol}:connected`:
          setConnecting(false);
          break;
        case `${protocol}:error`: {
          const message =
            "error" in frame && typeof frame.error === "string" ? frame.error : undefined;
          // An untrusted or changed host key isn't a failure yet — it's a
          // question. Ask it, and reconnect if the operator pins the key.
          const trust = trustPayloadFromFrame(frame);
          if (trust) {
            setConnecting(false);
            setOverlay({ title: "Verifying host key…" });
            void requestHostKeyTrust(trust).then((accepted) => {
              if (disposed) return;
              if (accepted) setAttempt((n) => n + 1);
              else setOverlay({ title: "Connection error", message: trust.message });
            });
            break;
          }
          setConnecting(false);
          setOverlay({ title: "Connection error", ...(message ? { message } : {}) });
          break;
        }
        case `${protocol}:closed`:
          setConnecting(false);
          setOverlay((current) => current ?? { title: "Session ended" });
          break;
      }
    });
    const offClose = session.onClose(() => {
      if (disposed) return;
      setConnecting(false);
      // A dead pty can't resume — surface the close instead of reconnecting.
      // The exception is the host-key handshake: the proxy drops the socket
      // right after refusing, and that overlay is already on screen.
      setOverlay((current) => current ?? { title: "Connection closed" });
    });
    const offError = session.onError(() => {
      // The close listener produces the user-facing overlay.
    });

    session
      .connect()
      .then(() => {
        if (!disposed) setWsConnected(true);
      })
      .catch((e) => {
        if (disposed) return;
        setConnecting(false);
        setOverlay({
          title: "Failed to connect",
          message: e instanceof Error ? e.message : "WebSocket connection failed",
        });
      });

    return () => {
      disposed = true;
      offFrame();
      offClose();
      offError();
      session.close();
      sessionRef.current = null;
    };
  }, [api, orgId, protocol, attempt]);

  // Open the pty once both the socket and the xterm page are up.
  useEffect(() => {
    if (!wsConnected || !webviewReady || openSentRef.current) return;
    openSentRef.current = true;
    sessionRef.current?.send({
      ...openFrame,
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
    } as never);
  }, [wsConnected, webviewReady, openFrame]);

  const handleReady = useCallback(() => setWebviewReady(true), []);
  const handleInput = useCallback(
    (b64: string) => {
      sessionRef.current?.send({ type: `${protocol}:data`, data: b64 } as never);
    },
    [protocol],
  );
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      sizeRef.current = { cols, rows };
      if (openSentRef.current) {
        sessionRef.current?.send({ type: `${protocol}:resize`, cols, rows } as never);
      }
    },
    [protocol],
  );

  return (
    <KeyboardAvoider style={styles.container}>
      <View style={{ flex: 1 }}>
        <TerminalWebView
          ref={termRef}
          onReady={handleReady}
          onInput={handleInput}
          onResize={handleResize}
        />
        {connecting && overlay === null && (
          <View style={styles.connecting} pointerEvents="none">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.connectingText}>Connecting…</Text>
          </View>
        )}
        {overlay !== null && (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>{overlay.title}</Text>
            {overlay.message ? <Text style={styles.overlayMessage}>{overlay.message}</Text> : null}
            <Button label="Close" onPress={() => router.back()} />
          </View>
        )}
      </View>
      <TerminalKeyBar onKey={handleInput} />
    </KeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0d10" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  centerText: { color: colors.textMuted, textAlign: "center", lineHeight: 20 },
  connecting: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  connectingText: { color: colors.textMuted, fontSize: 13 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: "rgba(11, 13, 16, 0.88)",
  },
  overlayTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  overlayMessage: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
});

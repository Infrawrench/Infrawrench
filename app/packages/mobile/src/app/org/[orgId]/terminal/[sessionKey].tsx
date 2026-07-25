import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ServerFrame } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { WsSession } from "@/lib/ws/WsSession";
import {
  TerminalKeyBar,
  TerminalWebView,
  type TerminalWebViewHandle,
} from "@/components/terminal/TerminalWebView";
import { SqlConsole } from "@/components/terminal/SqlConsole";
import { Button, ErrorView } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, spacing } from "@/lib/theme";

/**
 * Full-screen interactive session. The sessionKey is built by the resource
 * detail screen as `${kind}--${accountId}--${resourceId}--${pluginId}` with
 * each segment URI-encoded; kind is "ssh" | "k8s-exec" (plus "sql" for the
 * SQL console, which only needs the accountId).
 */

interface ParsedSessionKey {
  kind: string;
  accountId: string;
  resourceId: string;
  pluginId: string;
}

function parseSessionKey(sessionKey: string): ParsedSessionKey | null {
  const parts = sessionKey.split("--");
  const [kind, accountId, resourceId, pluginId] = parts;
  if (parts.length !== 4 || !kind || !accountId || !resourceId || !pluginId) return null;
  try {
    return {
      kind: decodeURIComponent(kind),
      accountId: decodeURIComponent(accountId),
      resourceId: decodeURIComponent(resourceId),
      pluginId: decodeURIComponent(pluginId),
    };
  } catch {
    return null;
  }
}

export default function TerminalScreen() {
  const router = useRouter();
  const { sessionKey } = useLocalSearchParams<{ sessionKey: string }>();
  const parsed = useMemo(() => (sessionKey ? parseSessionKey(sessionKey) : null), [sessionKey]);

  if (!parsed) return <ErrorView message="Invalid terminal session link." />;

  if (parsed.kind === "ssh") {
    return <SshTerminal accountId={parsed.accountId} resourceId={parsed.resourceId} />;
  }
  if (parsed.kind === "sql") {
    return <SqlConsole accountId={parsed.accountId} />;
  }
  if (parsed.kind === "k8s-exec") {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>
          Kubernetes exec terminals aren't supported on mobile yet. Use the web or desktop app to
          pick a pod and open a shell.
        </Text>
        <Button label="Go back" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }
  return <ErrorView message={`Unknown terminal type "${parsed.kind}".`} />;
}

function SshTerminal({ accountId, resourceId }: { accountId: string; resourceId: string }) {
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

  useEffect(() => {
    // Re-entry (api/orgId change) builds a fresh session — reset the handshake
    // state so the new socket sends its own ssh:open.
    setWsConnected(false);
    openSentRef.current = false;
    const session = new WsSession({ api, orgId });
    sessionRef.current = session;
    let disposed = false;

    const offFrame = session.onFrame((frame: ServerFrame) => {
      if (disposed) return;
      switch (frame.type) {
        case "ssh:data": {
          const data = (frame as { data?: unknown }).data;
          if (typeof data === "string") termRef.current?.write(data);
          setConnecting(false);
          break;
        }
        case "ssh:ready":
          setConnecting(false);
          break;
        case "ssh:error": {
          const message =
            "error" in frame && typeof frame.error === "string" ? frame.error : undefined;
          setConnecting(false);
          setOverlay({ title: "Connection error", ...(message ? { message } : {}) });
          break;
        }
        case "ssh:close":
          setConnecting(false);
          setOverlay((current) => current ?? { title: "Session ended" });
          break;
      }
    });
    const offClose = session.onClose(() => {
      if (disposed) return;
      setConnecting(false);
      // A dead pty can't resume — surface the close instead of reconnecting.
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
  }, [api, orgId]);

  // Open the pty once both the socket and the xterm page are up.
  useEffect(() => {
    if (!wsConnected || !webviewReady || openSentRef.current) return;
    openSentRef.current = true;
    sessionRef.current?.send({
      type: "ssh:open",
      accountId,
      resourceId,
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
    });
  }, [wsConnected, webviewReady, accountId, resourceId]);

  const handleReady = useCallback(() => setWebviewReady(true), []);
  const handleInput = useCallback((b64: string) => {
    sessionRef.current?.send({ type: "ssh:data", data: b64 });
  }, []);
  const handleResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    if (openSentRef.current) sessionRef.current?.send({ type: "ssh:resize", cols, rows });
  }, []);

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

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  CloudApiError,
  hostKeyLabel,
  hostKeyTrustRequestBody,
  isHostKeyTrustResponse,
  type HostKeyTrustPayload,
} from "@infrawrench/client-core";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Button } from "@/components/ui";
import { registerHostKeyTrustPrompt, setTrustRequestInFlight } from "@/lib/ssh/host-key-trust";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * The host-key trust prompt, mounted once near the root. Mirrors the web
 * HostKeyTrustDialog: shows the presented fingerprint (and the one previously
 * pinned, when the key changed), and on accept pins it via
 * `POST /ssh-host-keys/trust` before telling the caller to retry.
 *
 * Mobile used to have no prompt at all — an unknown host meant reading the
 * refusal as red text and going to a desktop to accept the key.
 */
export function HostKeyTrustHost() {
  const { api, orgId } = useAuth();
  const [payload, setPayload] = useState<HostKeyTrustPayload | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held across the modal's lifetime: resolved with the operator's answer so
  // the awaiting fetch/terminal can continue.
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => {
    registerHostKeyTrustPrompt(
      (next) =>
        new Promise<boolean>((resolve) => {
          // A second refusal while one is on screen (two requests racing the
          // same unknown host) — answer it with the same decision.
          const previous = resolveRef.current;
          resolveRef.current = (accepted) => {
            previous?.(accepted);
            resolve(accepted);
          };
          setError(null);
          setPayload(next);
        }),
    );
    return () => registerHostKeyTrustPrompt(null);
  }, []);

  const settle = useCallback((accepted: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPayload(null);
    setSubmitting(false);
    resolve?.(accepted);
  }, []);

  const confirm = useCallback(async () => {
    if (!payload || !orgId) return;
    setSubmitting(true);
    setError(null);
    setTrustRequestInFlight(true);
    try {
      await api.org(orgId, "/ssh-host-keys/trust", {
        method: "POST",
        body: JSON.stringify(hostKeyTrustRequestBody(payload)),
      });
      settle(true);
    } catch (e) {
      // A concurrent connect can present a different key than the one just
      // accepted. Swap the new fingerprint in and let the operator decide
      // again rather than pinning something they never saw.
      const race = racePayload(e);
      if (race) {
        setPayload(race);
        setError(
          "The host key changed again while you were accepting it. Please review and retry.",
        );
      } else {
        setError(e instanceof Error ? e.message : "Failed to trust host key");
      }
      setSubmitting(false);
    } finally {
      setTrustRequestInFlight(false);
    }
  }, [api, orgId, payload, settle]);

  if (!payload) return null;

  const isMismatch = payload.kind === "mismatch";

  return (
    <Modal visible animationType="slide" transparent onRequestClose={() => settle(false)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={[styles.title, isMismatch && styles.titleDanger]}>
            {isMismatch ? "Host key has changed!" : "Verify SSH host key"}
          </Text>
          <Text style={styles.host}>{hostKeyLabel(payload)}</Text>

          <ScrollView style={styles.body}>
            <Text style={isMismatch ? styles.warning : styles.explanation}>
              {isMismatch
                ? "The fingerprint of this host's SSH key does not match the one you previously trusted. This can happen if the server was rebuilt or its key was rotated, but it can also mean someone is intercepting the connection. Only continue if you are certain the new key is legitimate."
                : "You haven't connected to this host before. Confirm the fingerprint below matches what you expect — the value your provider published, or what `ssh-keygen -lf` prints on the host."}
            </Text>

            {payload.storedFingerprint ? (
              <Fingerprint label="Previously trusted" value={payload.storedFingerprint} muted />
            ) : null}
            <Fingerprint
              label={payload.storedFingerprint ? "Now presented" : "Presented fingerprint"}
              value={payload.presentedFingerprint}
              danger={isMismatch}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.actions}>
            <Button
              label="Cancel"
              variant="secondary"
              disabled={submitting}
              onPress={() => settle(false)}
            />
            <Button
              label={
                submitting ? "Trusting…" : isMismatch ? "Replace key" : "Trust key and continue"
              }
              disabled={submitting}
              onPress={() => void confirm()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Pull a fresh trust payload out of a 409 thrown by the trust POST itself. */
function racePayload(e: unknown): HostKeyTrustPayload | null {
  if (!(e instanceof CloudApiError) || e.status !== 409) return null;
  try {
    const parsed: unknown = JSON.parse(e.body);
    return isHostKeyTrustResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function Fingerprint({
  label,
  value,
  muted,
  danger,
}: {
  label: string;
  value: string;
  muted?: boolean;
  danger?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.fingerprint}>
      <View style={styles.fingerprintHeader}>
        <Text style={styles.fingerprintLabel}>{label}</Text>
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Text style={styles.copy}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <Text
        style={[
          styles.fingerprintValue,
          muted && styles.fingerprintMuted,
          danger && styles.fingerprintDanger,
        ]}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.7)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    maxHeight: "88%",
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  titleDanger: { color: colors.danger },
  host: { color: colors.textMuted, fontFamily: "monospace", fontSize: 12 },
  body: { marginVertical: spacing.sm },
  explanation: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  warning: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  fingerprint: { marginTop: spacing.md, gap: spacing.xs },
  fingerprintHeader: { flexDirection: "row", justifyContent: "space-between" },
  fingerprintLabel: { color: colors.textMuted, fontSize: 12 },
  copy: { color: colors.textFaint, fontSize: 12 },
  fingerprintValue: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.textSecondary,
    fontFamily: "monospace",
    fontSize: 12,
    padding: spacing.sm,
  },
  fingerprintMuted: { color: colors.textFaint },
  fingerprintDanger: { color: colors.danger },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});

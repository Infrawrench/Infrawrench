import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { normalizeTerminalLinkUrl } from "@infrawrench/client-core";
import { terminalHtml } from "../../../assets/generated/terminal-html";
import { utf8ToBase64 } from "@/lib/base64";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * WebView hosting the generated xterm.js page (assets/generated/terminal.html,
 * built by scripts/build-terminal-html.mjs). The bridge:
 *   page → RN: postMessage JSON {type:"ready"} | {type:"input", b64} |
 *              {type:"resize", cols, rows}
 *   RN → page: injectJavaScript → window.__terminalWrite(b64) / __terminalFit()
 */

export interface TerminalWebViewHandle {
  /** Write base64-encoded bytes (e.g. an ssh:data payload) to the terminal. */
  write(b64: string): void;
  /** Refit the terminal to the viewport; the page reports the new size back. */
  fit(): void;
}

interface TerminalWebViewProps {
  onReady: () => void;
  onInput: (b64: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export const TerminalWebView = forwardRef<TerminalWebViewHandle, TerminalWebViewProps>(
  function TerminalWebView({ onReady, onInput, onResize }, ref) {
    const webviewRef = useRef<WebView>(null);

    useImperativeHandle(
      ref,
      () => ({
        write(b64: string) {
          // b64 is [A-Za-z0-9+/=] only, but JSON.stringify keeps this safe anyway.
          webviewRef.current?.injectJavaScript(
            `window.__terminalWrite && window.__terminalWrite(${JSON.stringify(b64)}); true;`,
          );
        },
        fit() {
          webviewRef.current?.injectJavaScript(
            "window.__terminalFit && window.__terminalFit(); true;",
          );
        },
      }),
      [],
    );

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let msg: { type?: string; b64?: string; cols?: number; rows?: number; url?: string };
        try {
          msg = JSON.parse(event.nativeEvent.data) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          onReady();
        } else if (msg.type === "input" && typeof msg.b64 === "string") {
          onInput(msg.b64);
        } else if (
          msg.type === "resize" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          onResize(msg.cols, msg.rows);
        } else if (msg.type === "openUrl" && typeof msg.url === "string") {
          // Re-validate on this side of the bridge. The WebView already
          // refuses non-http schemes, but the URL originated in remote
          // terminal output and this is the boundary that hands it to the OS.
          const url = normalizeTerminalLinkUrl(msg.url);
          if (url) void Linking.openURL(url);
        }
      },
      [onReady, onInput, onResize],
    );

    return (
      <WebView
        ref={webviewRef}
        source={{ html: terminalHtml }}
        onMessage={handleMessage}
        originWhitelist={["*"]}
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        scrollEnabled={false}
        setBuiltInZoomControls={false}
        style={styles.webview}
      />
    );
  },
);

/** Keys phone keyboards lack; each sends its escape sequence as base64. */
const ACCESSORY_KEYS: Array<{ label: string; sequence: string }> = [
  { label: "Esc", sequence: "\x1b" },
  { label: "Tab", sequence: "\t" },
  { label: "Ctrl+C", sequence: "\x03" },
  { label: "↑", sequence: "\x1b[A" },
  { label: "↓", sequence: "\x1b[B" },
  { label: "←", sequence: "\x1b[D" },
  { label: "→", sequence: "\x1b[C" },
];

/** Accessory bar rendered above the keyboard; routes through onInput's channel. */
export function TerminalKeyBar({ onKey }: { onKey: (b64: string) => void }) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.keyBar}
      contentContainerStyle={styles.keyBarContent}
    >
      {ACCESSORY_KEYS.map((key) => (
        <Pressable
          key={key.label}
          accessibilityRole="button"
          accessibilityLabel={key.label}
          onPress={() => onKey(utf8ToBase64(key.sequence))}
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
        >
          <Text style={styles.keyText}>{key.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: "#0b0d10",
  },
  keyBar: {
    flexGrow: 0,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  keyBarContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  key: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    minWidth: 44,
    alignItems: "center",
  },
  keyPressed: { backgroundColor: colors.borderStrong },
  keyText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
});

/**
 * WebView-side terminal entry, bundled by build-terminal-html.mjs into a
 * self-contained HTML file. Hosts an xterm.js terminal and bridges it to
 * React Native over the WebView message channel:
 *
 *   WV → RN (window.ReactNativeWebView.postMessage, JSON):
 *     { type: "ready" }                 once the terminal is initialized
 *     { type: "input", b64 }            user keystrokes (base64 of utf8)
 *     { type: "resize", cols, rows }    after every fit
 *     { type: "openUrl", url }          a link in the output was tapped
 *
 *   RN → WV (injectJavaScript):
 *     window.__terminalWrite(b64)       decode base64 → term.write(bytes)
 *     window.__terminalFit()            refit to the viewport + report size
 *
 * Theme/options are copied from app/packages/ui/src/terminal-theme.ts and
 * xterm-options.ts (mobile cannot import @infrawrench/ui); background is
 * pinned to the app background #0b0d10.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

function post(msg) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
}

/** utf8 string → base64 (btoa only handles byte strings). */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → raw bytes; xterm accepts Uint8Array so no lossy re-decode. */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Copied from @infrawrench/ui terminal-theme.ts + xterm-options.ts (ANSI
// palette hard-coded there too); background matched to the mobile app.
const TERMINAL_THEME = {
  background: "#0b0d10",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#0b0d10",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#4ec9b0",
  yellow: "#dcdcaa",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#9cdcfe",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f44747",
  brightGreen: "#4ec9b0",
  brightYellow: "#dcdcaa",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#9cdcfe",
  brightWhite: "#ffffff",
};

function main() {
  const root = document.getElementById("root");
  if (!root) return;

  // Links printed by the remote host open in the system browser. The WebView
  // cannot navigate itself there, so the tap is forwarded to React Native,
  // which validates the scheme again before handing it to the OS — terminal
  // output is remote-controlled text.
  const linkHandler = {
    activate(_event, uri) {
      post({ type: "openUrl", url: uri });
    },
    allowNonHttpProtocols: false,
  };
  const term = new Terminal({
    linkHandler,
    theme: TERMINAL_THEME,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "block",
    allowTransparency: true,
    convertEol: false,
    scrollback: 10000,
    // Mirrors `getXtermTerminalOptions` in @infrawrench/ui — this bundle
    // cannot import it (it is a standalone WebView entry point), but the
    // terminal has to be readable by TalkBack and VoiceOver just the same.
    screenReaderMode: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // OSC 8 hyperlinks go through `linkHandler` above; this finds bare URLs.
  term.loadAddon(new WebLinksAddon((event, uri) => linkHandler.activate(event, uri)));
  term.open(root);

  let fitTimer = null;
  function doFit() {
    try {
      fit.fit();
    } catch {
      // Zero-sized viewport during layout; the next resize will refit.
    }
    post({ type: "resize", cols: term.cols, rows: term.rows });
  }
  function scheduleFit() {
    if (fitTimer !== null) clearTimeout(fitTimer);
    fitTimer = setTimeout(doFit, 50);
  }

  window.__terminalWrite = function (b64) {
    try {
      term.write(base64ToBytes(b64));
    } catch {
      // Malformed payload; drop it rather than kill the terminal.
    }
  };
  window.__terminalFit = doFit;

  term.onData(function (data) {
    post({ type: "input", b64: utf8ToBase64(data) });
  });

  window.addEventListener("resize", scheduleFit);
  if (window.visualViewport) {
    // The on-screen keyboard resizes the visual viewport, not always window.
    window.visualViewport.addEventListener("resize", scheduleFit);
  }

  doFit();
  post({ type: "ready" });
  term.focus();
}

try {
  main();
} catch (e) {
  post({ type: "error", message: e instanceof Error ? e.message : String(e) });
}

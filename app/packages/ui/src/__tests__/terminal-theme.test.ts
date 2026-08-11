import { describe, expect, it } from "vitest";
import { getTerminalTheme } from "../terminal-theme";
import {
  getTerminalAccessibleName,
  getTerminalContainerProps,
  getXtermTerminalOptions,
} from "../xterm-options";

describe("getTerminalTheme", () => {
  it("falls back to default colors when CSS vars are unset", () => {
    const theme = getTerminalTheme();
    expect(theme.background).toBe("#0d0d0d");
    expect(theme.foreground).toBe("#d4d4d4");
    expect(theme.cursor).toBe("#d4d4d4");
    expect(theme.cursorAccent).toBe("#0d0d0d");
    expect(theme.selectionBackground).toBe("#264f78");
  });

  it("reads CSS variables when present", () => {
    document.documentElement.style.setProperty("--color-terminal-bg", "#123456");
    const theme = getTerminalTheme();
    expect(theme.background).toBe("#123456");
    document.documentElement.style.removeProperty("--color-terminal-bg");
  });
});

describe("getXtermTerminalOptions", () => {
  it("returns merged theme with the full ANSI palette and base options", () => {
    const opts = getXtermTerminalOptions();
    expect(opts.theme.background).toBe("#0d0d0d");
    expect(opts.theme.red).toBe("#f44747");
    expect(opts.theme.brightWhite).toBe("#ffffff");
    expect(opts.fontSize).toBe(13);
    expect(opts.cursorStyle).toBe("block");
    expect(opts.scrollback).toBe(10000);
    expect(opts.convertEol).toBe(false);
  });

  // Every terminal in the app is constructed from these options, so this is
  // the one place that keeps SSH, k8s exec, k9s and recording playback
  // readable by NVDA/VoiceOver/Orca. Without it xterm renders only to its
  // canvas layer and the session is invisible to assistive technology.
  it("enables xterm's screen reader mode", () => {
    expect(getXtermTerminalOptions().screenReaderMode).toBe(true);
  });

  it("keeps screen reader mode on for agent terminals, which override scrollback", () => {
    const opts = getXtermTerminalOptions({ scrollback: 0 });
    expect(opts.scrollback).toBe(0);
    expect(opts.screenReaderMode).toBe(true);
  });
});

describe("getTerminalAccessibleName", () => {
  it("names an SSH terminal by user and host", () => {
    expect(getTerminalAccessibleName({ kind: "ssh", host: "web-1", username: "deploy" })).toBe(
      "SSH terminal, deploy@web-1",
    );
  });

  it("falls back to the host alone when no username is known", () => {
    expect(getTerminalAccessibleName({ kind: "ssh", host: "web-1" })).toBe("SSH terminal, web-1");
  });

  // Without `sshHost` the server dials whatever the plugin's getSshConfig()
  // reads out of the account credentials. Naming the resource or account id
  // here would announce an internal identifier in the slot a hostname
  // occupies, which reads as though it *is* the destination.
  it("asserts no destination when the host is unknown", () => {
    expect(getTerminalAccessibleName({ kind: "ssh" })).toBe("SSH terminal");
  });

  it("does not fall back to the username when the host is unknown", () => {
    const name = getTerminalAccessibleName({ kind: "ssh", username: "deploy" });
    expect(name).toBe("SSH terminal");
    expect(name).not.toContain("deploy");
  });

  it("names a k8s exec terminal by pod, namespace and container", () => {
    expect(
      getTerminalAccessibleName({
        kind: "k8s-exec",
        namespace: "prod",
        podName: "api-7f9",
        containerName: "api",
      }),
    ).toBe("Kubernetes exec terminal, pod api-7f9 in namespace prod, container api");
  });

  it("omits the container when the pod has only one", () => {
    expect(
      getTerminalAccessibleName({ kind: "k8s-exec", namespace: "prod", podName: "api-7f9" }),
    ).toBe("Kubernetes exec terminal, pod api-7f9 in namespace prod");
  });

  // An omitted namespace means the --namespace flag is not passed and k9s
  // opens on the kubeconfig context's default, which is not necessarily every
  // namespace — so the name must not claim a scope it cannot confirm.
  it("names a k9s terminal by namespace, and claims no scope without one", () => {
    expect(getTerminalAccessibleName({ kind: "k9s", namespace: "prod" })).toBe(
      "k9s terminal, namespace prod",
    );
    expect(getTerminalAccessibleName({ kind: "k9s" })).toBe("k9s terminal");
  });
});

describe("getTerminalContainerProps", () => {
  // role="application" is what drops NVDA/JAWS out of browse mode so that
  // keystrokes reach the remote shell instead of the screen reader.
  it("marks interactive terminals as application regions with a name", () => {
    expect(getTerminalContainerProps({ kind: "ssh", host: "web-1", username: "deploy" })).toEqual({
      role: "application",
      "aria-label": "SSH terminal, deploy@web-1",
    });
    expect(getTerminalContainerProps({ kind: "k9s" }).role).toBe("application");
    expect(
      getTerminalContainerProps({ kind: "k8s-exec", namespace: "prod", podName: "api-7f9" }).role,
    ).toBe("application");
  });

  // Playback sets disableStdin: there is nothing to type into it, and focus
  // mode would remove the arrow-key navigation used to read the replay.
  it("keeps the recording player browsable rather than an application region", () => {
    expect(getTerminalContainerProps({ kind: "playback" })).toEqual({
      role: "group",
      "aria-label": "Session recording playback terminal",
    });
  });
});

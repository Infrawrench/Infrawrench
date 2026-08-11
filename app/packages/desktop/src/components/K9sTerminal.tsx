import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../lib/invoke";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  getTerminalContainerProps,
  getXtermTerminalOptions,
} from "@infrawrench/ui";
import { openK9s, type K8sSessionHandle } from "../lib/k8s-dispatch";

const K9S_INSTALL_URL = "https://k9scli.io/topics/install/";

interface K9sCloudContext {
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
}

interface K9sTerminalProps {
  /** Required for local mode. */
  kubeconfig?: string;
  cloudContext?: K9sCloudContext;
  namespace?: string;
}

export function K9sTerminal({ kubeconfig, cloudContext, namespace }: K9sTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nativeK9sInstalled, setNativeK9sInstalled] = useState<boolean | null>(null);

  const cloudOrgId = cloudContext?.orgId;
  const cloudAccountId = cloudContext?.accountId;
  const cloudResourceId = cloudContext?.resourceId;
  const cloudPeerPluginId = cloudContext?.peerPluginId;
  const isCloud = cloudContext != null;

  // In cloud mode the server owns the k9s binary; availability is surfaced via
  // the WS error channel if missing, not via a pre-flight check.
  const k9sInstalled = isCloud ? true : nativeK9sInstalled;

  useEffect(() => {
    if (isCloud) {
      // The cloud server owns the k9s binary; availability is surfaced via the
      // WS error channel if missing, not via a pre-flight check.
      return;
    }
    let cancelled = false;
    invoke<boolean>("k9s_check")
      .then((installed) => {
        if (!cancelled) setNativeK9sInstalled(installed);
      })
      .catch(() => {
        if (!cancelled) setNativeK9sInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCloud]);

  useEffect(() => {
    if (k9sInstalled !== true || !containerRef.current) return;

    const term = new Terminal(getXtermTerminalOptions());

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const clipboard = attachTerminalClipboard(term);

    let session: K8sSessionHandle | null = null;
    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();
      term.write("\x1b[90mLaunching k9s…\x1b[0m\r\n");

      const openPromise =
        isCloud && cloudOrgId && cloudAccountId && cloudResourceId && cloudPeerPluginId
          ? openK9s({
              mode: "cloud",
              orgId: cloudOrgId,
              accountId: cloudAccountId,
              resourceId: cloudResourceId,
              peerPluginId: cloudPeerPluginId,
              ...(namespace ? { namespace } : {}),
              cols: term.cols,
              rows: term.rows,
            })
          : openK9s({
              mode: "local",
              kubeconfig: kubeconfig ?? "",
              ...(namespace ? { namespace } : {}),
              cols: term.cols,
              rows: term.rows,
            });

      openPromise
        .then((handle) => {
          if (disposed) {
            handle.kill();
            return;
          }
          session = handle;
          handle.onData((data) => term.write(data));
          handle.onExit(() => term.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n"));
          handle.onError((err) => term.write(`\r\n\x1b[31m${err}\x1b[0m\r\n`));
        })
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
        });
    });

    const sendToSession = (data: string) => session?.write(data);
    const onData = term.onData(sendToSession);
    const altScroll = attachAltBufferScrollHandler(term, sendToSession);

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      session?.resize(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      onData.dispose();
      altScroll.dispose();
      clipboard.dispose();
      session?.kill();
      term.dispose();
    };
  }, [
    k9sInstalled,
    kubeconfig,
    namespace,
    isCloud,
    cloudOrgId,
    cloudAccountId,
    cloudResourceId,
    cloudPeerPluginId,
  ]);

  if (k9sInstalled === null) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[var(--color-terminal-bg)] text-sm text-on-surface-muted">
        Checking for k9s…
      </div>
    );
  }

  if (!k9sInstalled) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[var(--color-terminal-bg)] p-6">
        <div className="max-w-sm text-center space-y-3">
          <p className="text-base font-medium text-on-surface-secondary">k9s not found</p>
          <p className="text-sm text-on-surface-muted">
            Install `k9s` locally to use the embedded Kubernetes terminal view.
          </p>
          <button
            type="button"
            onClick={() => void invoke("open_external_url", { url: K9S_INSTALL_URL })}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          >
            Open install guide
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 p-2"
        {...getTerminalContainerProps({ kind: "k9s", namespace })}
      />
    </div>
  );
}

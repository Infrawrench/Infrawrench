import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter, createHashHistory } from "@tanstack/react-router";
import { t } from "gt-react";
import { Toaster, toast, useUIStore } from "@infrawrench/ui";
import { routeTree } from "./routeTree.gen";
import { subscribeRpc } from "./lib/rpc/subscribe";
import "./globals.css";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  toast.error(t("Something went wrong"), {
    description: reason instanceof Error ? reason.message : String(reason),
  });
});

// A sign-in that failed in the main process's protocol callback.
subscribeRpc(
  "cloud-auth",
  (rpc) => rpc.CloudAuthErrors(),
  (failure) => {
    toast.error(t("Sign-in failed"), {
      description: failure.message || t("Cloud authentication error"),
    });
  },
);

// A local account's OAuth connection changed state in the main process (a
// refresh was rejected, or a reconnect succeeded): the sidebar and account
// pages re-read `oauth_status`.
subscribeRpc(
  "provider-oauth",
  (rpc) => rpc.ProviderOAuthStatusChanges(),
  () => {
    useUIStore.getState().bumpAccounts();
  },
);

const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "red", background: "white" }}>
          <h2>{t("Render error")}</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
      <Toaster />
    </ErrorBoundary>
  </StrictMode>,
);

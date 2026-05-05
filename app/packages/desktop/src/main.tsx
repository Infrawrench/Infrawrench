import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter, createHashHistory } from "@tanstack/react-router";
import { Toaster, toast } from "@infrawrench/ui";
import { routeTree } from "./routeTree.gen";
import "./globals.css";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  toast.error("Something went wrong", {
    description: reason instanceof Error ? reason.message : String(reason),
  });
});

window.electronAPI.on("cloud_auth_error", (...args: unknown[]) => {
  const payload = args[0] as { code?: string; message?: string } | undefined;
  toast.error("Sign-in failed", {
    description: payload?.message ?? "Cloud authentication error",
  });
});

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
          <h2>Render error</h2>
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

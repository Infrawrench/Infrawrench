import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { t } from "gt-react";
import { Toaster, toast } from "@infrawrench/ui";
import { routeTree } from "./routeTree.gen";
import "./globals.css";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  toast.error(t("Something went wrong"), {
    description: reason instanceof Error ? reason.message : String(reason),
  });
});

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster />
  </StrictMode>,
);

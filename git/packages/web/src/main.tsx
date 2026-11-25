import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { queryClient } from "./api/queries";
import { Page } from "./components/Panel";
import { EmptyState } from "./components/states";
import { ButtonLink } from "./components/Button";
import { routeTree } from "./routeTree.gen";
import "./globals.css";

// The dev mock answers the API in the browser. The check is a build-time
// constant, so a production build drops the import and everything behind it.
if (import.meta.env.VITE_GIT_MOCK === "1") {
  const { installMock } = await import("./mock");
  installMock();
}

function NotFound() {
  return (
    <Page>
      <EmptyState action={<ButtonLink href="/">Home</ButtonLink>}>Page not found</EmptyState>
    </Page>
  );
}

const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

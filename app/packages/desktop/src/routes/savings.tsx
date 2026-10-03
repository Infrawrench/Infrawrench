import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Potential savings is a section of Costs. This route only redirects, so
 * restored windows and existing links land on the content rather than a 404.
 */
export const Route = createFileRoute("/savings")({
  beforeLoad: () => {
    throw redirect({ to: "/costs", replace: true });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Potential savings used to be its own page; it is now a section of Costs.
 * The route is kept as a redirect so restored windows and existing links land
 * on the content rather than a 404.
 */
export const Route = createFileRoute("/savings")({
  beforeLoad: () => {
    throw redirect({ to: "/costs", replace: true });
  },
});

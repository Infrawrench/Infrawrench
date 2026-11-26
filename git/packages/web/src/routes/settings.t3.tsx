import { createFileRoute } from "@tanstack/react-router";
import { T3Page } from "../features/settings/T3Page";
import { type T3Outcome, outcomeOf } from "../features/settings/t3";

function T3Route() {
  const { t3 } = Route.useSearch();
  return t3 === undefined ? <T3Page /> : <T3Page outcome={t3} />;
}

export const Route = createFileRoute("/settings/t3")({
  component: T3Route,
  // `?t3=`: how the browser came back from signing in to an environment.
  validateSearch: (search: Record<string, unknown>): { t3?: T3Outcome } => {
    const t3 = outcomeOf(search.t3);
    return t3 === undefined ? {} : { t3 };
  },
});

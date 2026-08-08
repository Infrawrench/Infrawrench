import { createFileRoute } from "@tanstack/react-router";
import { CurrencySection } from "@infrawrench/ui";

// Thin wrapper: the section itself is shared with the desktop app's settings
// tab and lives in @infrawrench/ui (see settings/host.tsx for the contract).
export const Route = createFileRoute("/org/$orgId/settings/currency")({
  component: CurrencySection,
});

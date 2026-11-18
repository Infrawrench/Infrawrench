import { createFileRoute } from "@tanstack/react-router";

// One game day's report. Like the list above it, the content renders in the
// workspace-tab viewport (which keeps every open tab mounted); this route only
// claims the URL so a game day link is shareable.
export const Route = createFileRoute("/org/$orgId/game-days/$gameDayId")({
  component: () => null,
});

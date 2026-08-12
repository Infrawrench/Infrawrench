import { createFileRoute } from "@tanstack/react-router";

// The standalone status-pages workspace tab claims this URL.
export const Route = createFileRoute("/status-pages")({ component: () => null });

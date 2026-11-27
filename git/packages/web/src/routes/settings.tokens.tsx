import { createFileRoute } from "@tanstack/react-router";
import { TokensPage } from "../features/settings/TokensPage";

export const Route = createFileRoute("/settings/tokens")({ component: TokensPage });

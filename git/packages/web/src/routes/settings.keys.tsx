import { createFileRoute } from "@tanstack/react-router";
import { KeysPage } from "../features/settings/KeysPage";

export const Route = createFileRoute("/settings/keys")({ component: KeysPage });

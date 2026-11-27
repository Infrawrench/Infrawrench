import { createFileRoute } from "@tanstack/react-router";
import { OrganisationsPage } from "../features/settings/OrganisationsPage";

export const Route = createFileRoute("/settings/organisations")({ component: OrganisationsPage });

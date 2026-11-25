import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "../features/settings/ProfilePage";

export const Route = createFileRoute("/settings/")({ component: ProfilePage });

import { createFileRoute } from "@tanstack/react-router";
import { NewIssuePage } from "../../../features/issues/NewIssuePage";

export const Route = createFileRoute("/$owner/$repo/issues/new")({ component: NewIssuePage });

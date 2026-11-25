import { createFileRoute } from "@tanstack/react-router";
import { TagsPage } from "../../../features/code/TagsPage";

export const Route = createFileRoute("/$owner/$repo/tags")({ component: TagsPage });

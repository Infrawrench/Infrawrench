import { createFileRoute } from "@tanstack/react-router";
import { MentionsPage } from "../features/workspace/ListPages";

export const Route = createFileRoute("/mentions")({ component: MentionsPage });

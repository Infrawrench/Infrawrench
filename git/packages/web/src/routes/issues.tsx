import { createFileRoute } from "@tanstack/react-router";
import { MyIssuesPage } from "../features/workspace/ThreadPages";

export const Route = createFileRoute("/issues")({ component: MyIssuesPage });

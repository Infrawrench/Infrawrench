import { createFileRoute } from "@tanstack/react-router";
import { MyPullsPage } from "../features/workspace/ThreadPages";

export const Route = createFileRoute("/pulls")({ component: MyPullsPage });

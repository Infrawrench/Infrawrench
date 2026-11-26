import { createFileRoute } from "@tanstack/react-router";
import { ChangesPage } from "../features/workspace/ListPages";

export const Route = createFileRoute("/changes")({ component: ChangesPage });

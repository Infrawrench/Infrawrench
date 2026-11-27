import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../features/workspace/AgentHome";

export const Route = createFileRoute("/")({ component: HomePage });

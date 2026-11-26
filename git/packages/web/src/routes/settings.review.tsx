import { createFileRoute } from "@tanstack/react-router";
import { ReviewPage } from "../features/settings/ReviewPage";

export const Route = createFileRoute("/settings/review")({ component: ReviewPage });

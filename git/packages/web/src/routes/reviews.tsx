import { createFileRoute } from "@tanstack/react-router";
import { ReviewsPage } from "../features/workspace/ListPages";

export const Route = createFileRoute("/reviews")({ component: ReviewsPage });

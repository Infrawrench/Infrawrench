import { createFileRoute } from "@tanstack/react-router";
import { LabelsPage } from "../../../features/labels/LabelsPage";

export const Route = createFileRoute("/$owner/$repo/issues/labels")({ component: LabelsPage });

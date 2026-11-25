import { createFileRoute } from "@tanstack/react-router";
import { ComparePage } from "../../../features/code/ComparePage";

function ComparePicker() {
  return <ComparePage base={null} head={null} />;
}

export const Route = createFileRoute("/$owner/$repo/compare/")({ component: ComparePicker });

import { createFileRoute } from "@tanstack/react-router";
import { ConversationTab } from "../../../features/pulls/ConversationTab";

export const Route = createFileRoute("/$owner/$repo/pulls/$number/")({
  component: ConversationTab,
});

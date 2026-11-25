import { createFileRoute } from "@tanstack/react-router";
import { FilesTab } from "../../../features/pulls/FilesTab";

export const Route = createFileRoute("/$owner/$repo/pulls/$number/files")({ component: FilesTab });

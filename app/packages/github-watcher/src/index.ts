import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { GithubWatcher } from "./loop";

async function main(): Promise<void> {
  if (!isGithubAppConfigured()) {
    console.warn(
      "[github-watcher] GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set — watcher will idle until configured.",
    );
  }

  // The git trigger runs the workflow, which needs the plugin clients.
  const plugins = await loadPlugins();
  console.log(`[github-watcher] loaded ${plugins.length} plugins`);

  const watcher = new GithubWatcher();
  watcher.start();
  console.log("[github-watcher] started (30s tick)");

  const shutdown = async (signal: string) => {
    console.log(`[github-watcher] received ${signal}, draining...`);
    await watcher.stop();
    console.log("[github-watcher] shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[github-watcher] fatal:", e);
  process.exit(1);
});

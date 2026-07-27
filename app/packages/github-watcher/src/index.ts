import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { installShutdownHandlers, runService } from "@infrawrench/server-core/tick-loop";
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

  installShutdownHandlers("github-watcher", watcher);
}

runService("github-watcher", main);

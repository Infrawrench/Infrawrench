import { useEffect } from "react";
import { useGT } from "gt-react";
import { toast } from "@infrawrench/ui";

/**
 * Surfaces the result of the GitHub App install round-trip as a toast.
 *
 * `/api/github/setup` redirects back into the app with `?github=connected`,
 * `?github=requested` (install awaiting an org-owner's approval on GitHub) or
 * `?github=error`. Mounted once in the root layout so it fires no matter which
 * page the callback lands on, before any auth redirect strips the params.
 */
export function useGithubInstallResultToast(): void {
  const gt = useGT();
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("github");
    if (!result) return;
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url.toString());
    switch (result) {
      case "connected":
        toast.success(gt("GitHub connected"), {
          description: gt("Your repositories are now available in the repo picker."),
        });
        break;
      case "requested":
        toast.info(gt("GitHub install requested"), {
          description: gt(
            "An owner of the GitHub organization has to approve the installation before repositories show up.",
          ),
          duration: 10000,
        });
        break;
      default:
        toast.error(gt("GitHub connection failed"), {
          description: gt("The install couldn't be completed. Try connecting again."),
        });
        break;
    }
  }, []);
}

import { useCallback, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { isExternalUrl, safeLinkUrl, sitePath, webUrl } from "../lib/safe-url";

export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /**
   * A path on this site, from `lib/paths.ts`, or a web address. Anything
   * else (`javascript:`, `data:`) renders the children without a link.
   */
  readonly href: string;
  /** Replace the history entry instead of adding one (a filter, a tab). */
  readonly replace?: boolean;
}

/**
 * The link every page uses. A path on this site navigates in the router
 * without a page load; anything else (and any modified click) is a plain
 * anchor. It takes an `href` string rather than a typed route so that pages
 * link through `lib/paths.ts`, where refs and paths with slashes are encoded
 * once.
 */
export function AppLink({ href, replace = false, onClick, target, rel, ...rest }: AppLinkProps) {
  const router = useRouter();
  const safe = safeLinkUrl(href, { mailto: true });
  const internal = safe === null ? null : sitePath(safe);
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target !== undefined && target !== "_self") ||
      internal === null ||
      rest.download !== undefined
    ) {
      return;
    }
    event.preventDefault();
    if (replace) router.history.replace(internal);
    else router.history.push(internal);
  };
  if (safe === null) return <a {...rest} target={target} />;
  return (
    <a
      {...rest}
      href={safe}
      target={target}
      rel={rel ?? (isExternalUrl(safe) ? "noopener noreferrer" : undefined)}
      onClick={handle}
    />
  );
}

/** Navigate from code (after a form saves): `const go = useGo(); go(paths.repo(r))`. */
export function useGo(): (href: string, options?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (href, options) => {
      const path = sitePath(href);
      if (path === null) {
        // Only a web address leaves the site; anything else goes nowhere.
        const web = webUrl(href);
        if (web !== null) window.location.assign(web);
      } else if (options?.replace === true) router.history.replace(path);
      else router.history.push(path);
    },
    [router],
  );
}

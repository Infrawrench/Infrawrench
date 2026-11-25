import { useCallback, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { useRouter } from "@tanstack/react-router";

export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** A path on this site, from `lib/paths.ts`, or any other URL. */
  readonly href: string;
  /** Replace the history entry instead of adding one (a filter, a tab). */
  readonly replace?: boolean;
}

const isInternal = (href: string): boolean => href.startsWith("/") && !href.startsWith("//");

/**
 * The link every page uses. A path on this site navigates in the router
 * without a page load; anything else (and any modified click) is a plain
 * anchor. It takes an `href` string rather than a typed route so that pages
 * link through `lib/paths.ts`, where refs and paths with slashes are encoded
 * once.
 */
export function AppLink({ href, replace = false, onClick, target, ...rest }: AppLinkProps) {
  const router = useRouter();
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
      !isInternal(href) ||
      rest.download !== undefined
    ) {
      return;
    }
    event.preventDefault();
    if (replace) router.history.replace(href);
    else router.history.push(href);
  };
  return <a {...rest} href={href} target={target} onClick={handle} />;
}

/** Navigate from code (after a form saves): `const go = useGo(); go(paths.repo(r))`. */
export function useGo(): (href: string, options?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (href, options) => {
      if (!isInternal(href)) window.location.assign(href);
      else if (options?.replace === true) router.history.replace(href);
      else router.history.push(href);
    },
    [router],
  );
}

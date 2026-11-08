import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * `React.lazy` for a panel exported by name, so each workspace tab kind's code
 * downloads the first time a tab of that kind mounts rather than with the app.
 *
 * Load the panel by its own module path (`import("./WebDnsPanel")`, or an
 * `@infrawrench/ui/<dir>/<Module>` subpath for a shared panel), never through
 * the `@infrawrench/ui` barrel: the barrel is imported statically all over
 * the app, so a dynamic import of it splits nothing. `WorkspaceTabsViewport`
 * wraps every panel in a `Suspense` boundary, so a lazy panel needs no
 * boundary of its own there.
 *
 * Call it at module scope, once per panel: a component created during render
 * is a new type every time, which remounts the tab and throws its state away.
 */
export function lazyPanel<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => load().then((component) => ({ default: component })));
}

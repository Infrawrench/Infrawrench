/**
 * Effect schemas shared by the UI, the web API and the desktop app: request
 * bodies as the forms validate them and the API decodes them, with the
 * OpenAPI names and descriptions the API documents them under.
 *
 * React-free, its own build entry (`@infrawrench/ui/schemas`), so the server
 * can import it without the component barrel.
 */
export * from "./alert-email";
export * from "./budgets";
export * from "./checks";
export * from "./cost-filter";

/**
 * The git.infrawrench.com JSON API as Effect `HttpApi` definitions: every
 * group's endpoints, request and response schemas, error classes and the
 * annotations the worker enforces. No handlers and no server code; the worker
 * serves these definitions and the UI derives a typed client from them.
 *
 * Imports nothing but `effect`. Every export is flat, so a name two modules
 * both export fails the build (TS2308). NOTES.md has the conventions.
 */
export * from "./http/annotations";
export * from "./http/auth";
export * from "./http/errors";
export * from "./names";
export * from "./limits";
export * from "./urls";
export * from "./t3-connect";
export * from "./trailers";
export * from "./bots";
export * from "./languages";
export * from "./schemas/common";
export * from "./schemas/people";
export * from "./schemas/repository";
export * from "./schemas/git";
export * from "./schemas/threads";
export * from "./schemas/review";
export * from "./schemas/workspace";
export * from "./schemas/settings";
export * from "./schemas/imports";
export * from "./schemas/mirrors";
export * from "./schemas/ci";
export * from "./schemas/terraform";
export * from "./groups/session";
export * from "./groups/namespaces";
export * from "./groups/repositories";
export * from "./groups/contents";
export * from "./groups/issues";
export * from "./groups/branches";
export * from "./groups/review";
export * from "./groups/workspace";
export * from "./groups/settings";
export * from "./groups/imports";
export * from "./groups/mirrors";
export * from "./groups/automation";
export * from "./api";

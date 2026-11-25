/**
 * The dev mock: the whole API answered in the browser, behind
 * `VITE_GIT_MOCK=1`. `main.tsx` imports this file only then, so none of it
 * (handlers, fixtures) is in a production build.
 *
 * Every file in `handlers/` contributes endpoints; adding a feature's mock is
 * adding a file there. Two files answering the same endpoint is an error.
 */
import { ApiError, setTransport } from "../api/client";
import type { WireRequest } from "../api/types";
import type { MockHandlers } from "./define";

type AnyHandler = (request: WireRequest) => unknown;

const modules = import.meta.glob<{ default: MockHandlers }>("./handlers/*.ts", { eager: true });

function collect(): Map<string, AnyHandler> {
  const handlers = new Map<string, AnyHandler>();
  for (const [file, module] of Object.entries(modules)) {
    for (const [group, endpoints] of Object.entries(module.default)) {
      for (const [endpoint, handler] of Object.entries(endpoints ?? {})) {
        const key = `${group}.${endpoint}`;
        if (handlers.has(key)) throw new Error(`Two mock handlers for ${key} (second in ${file})`);
        handlers.set(key, handler as AnyHandler);
      }
    }
  }
  return handlers;
}

const delay = Number(import.meta.env.VITE_GIT_MOCK_DELAY ?? 40);

export function installMock(): void {
  const handlers = collect();
  setTransport(async ({ group, endpoint, request }) => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const handler = handlers.get(`${group}.${endpoint}`);
    if (handler === undefined) {
      throw new ApiError(501, `No mock handler for ${group}.${endpoint}`);
    }
    const answer = await handler(request);
    // A real answer is parsed JSON the caller owns; hand out a copy so nothing
    // a page does to it reaches the mock's own state.
    return answer === undefined ? undefined : structuredClone(answer);
  });
}

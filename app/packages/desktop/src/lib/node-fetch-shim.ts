// Renderer-side shim for `node-fetch`. `@netlify/api` (and any other
// transitively-pulled-in dep) imports `node-fetch`, which in v3 reaches into
// `node:util` and breaks Vite's browser build. Aliasing `node-fetch` → this
// file in the renderer's vite config substitutes the platform `fetch`
// instead. The renderer runs in a Chromium context with a global fetch.

const fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

export default fetchImpl;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;

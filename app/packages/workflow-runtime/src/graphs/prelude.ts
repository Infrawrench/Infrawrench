/**
 * Guest-side source injected before a custom-graph script. Builds
 * `globalThis.graph`, plus the same `fetch`/`console` a workflow gets.
 *
 * Controls are deliberately synchronous: their *values* are known at run start
 * (the client sent them in `__event`), so `graph.controls.select(...)` just
 * records the declaration locally and returns the resolved value — no RPC, no
 * `await`. The declarations ride along with the final `graph.render` RPC,
 * which the epilogue sends after the body settles. Only real data access
 * (costs, metrics, data store, fetch) awaits the host.
 */
import { GUEST_CODECS, GUEST_CONSOLE, GUEST_FETCH } from "../guest-lib.js";

export const GRAPH_PRELUDE = String.raw`
(() => {
  const rpc = async (method, args) => {
    const raw = await __host(method, JSON.stringify(args || {}));
    return raw === undefined || raw === null || raw === "" ? undefined : JSON.parse(raw);
  };

  ${GUEST_CODECS}

  // What started this run: { kind, button?, controls? }. Control values are
  // resolved from it synchronously below.
  const __ev = (() => {
    try { return JSON.parse(__event || "{}"); } catch (e) { return {}; }
  })();
  const state = (__ev && typeof __ev.controls === "object" && __ev.controls) || {};
  const pressed = typeof __ev.button === "string" ? __ev.button : undefined;

  // Declared controls, in declaration order — submitted with graph.render.
  const declared = [];
  const declaredIds = Object.create(null);
  const declare = (spec) => {
    if (typeof spec.id !== "string" || !spec.id) {
      throw new Error("graph.controls." + spec.kind + "(id, ...): id must be a non-empty string.");
    }
    if (declaredIds[spec.id]) {
      throw new Error("graph.controls: duplicate control id " + JSON.stringify(spec.id) + ".");
    }
    declaredIds[spec.id] = true;
    declared.push(spec);
  };

  const controls = {
    select: (id, opts) => {
      opts = opts || {};
      const raw = Array.isArray(opts.options) ? opts.options : [];
      const options = raw.map((o) =>
        typeof o === "string" ? { value: o, label: o } : { value: String(o.value), label: String(o.label ?? o.value) });
      if (options.length === 0) {
        throw new Error("graph.controls.select(" + JSON.stringify(id) + "): needs at least one option.");
      }
      const chosen = state[id];
      const valid = (v) => options.some((o) => o.value === v);
      const value = typeof chosen === "string" && valid(chosen) ? chosen
        : typeof opts.default === "string" && valid(opts.default) ? opts.default
        : options[0].value;
      declare({ kind: "select", id, label: String(opts.label ?? id), options, value });
      return value;
    },
    checkbox: (id, opts) => {
      opts = opts || {};
      const chosen = state[id];
      const value = typeof chosen === "boolean" ? chosen : Boolean(opts.default);
      declare({ kind: "checkbox", id, label: String(opts.label ?? id), value });
      return value;
    },
    text: (id, opts) => {
      opts = opts || {};
      const chosen = state[id];
      const value = typeof chosen === "string" ? chosen : String(opts.default ?? "");
      declare({
        kind: "text", id, label: String(opts.label ?? id), value,
        placeholder: opts.placeholder === undefined ? undefined : String(opts.placeholder),
      });
      return value;
    },
    number: (id, opts) => {
      opts = opts || {};
      const chosen = state[id];
      let value = typeof chosen === "number" && isFinite(chosen) ? chosen : Number(opts.default ?? 0);
      if (!isFinite(value)) value = 0;
      if (typeof opts.min === "number" && value < opts.min) value = opts.min;
      if (typeof opts.max === "number" && value > opts.max) value = opts.max;
      declare({
        kind: "number", id, label: String(opts.label ?? id), value,
        min: opts.min, max: opts.max, step: opts.step,
      });
      return value;
    },
    // Returns true iff this very run was started by pressing this button.
    button: (id, opts) => {
      opts = opts || {};
      declare({
        kind: "button", id, label: String(opts.label ?? id),
        danger: opts.danger ? true : undefined,
      });
      return pressed === id;
    },
  };

  // The last render(...) wins; the epilogue submits it after the body settles.
  let renderSpec;
  let rendered = false;
  globalThis.__graphSubmit = async () => {
    if (!rendered) return;
    await rpc("graph.render", { spec: renderSpec, controls: declared });
  };

  const graphLog = (...parts) => rpc("log", { level: "info", message: fmtParts(parts) });

  globalThis.graph = {
    controls,
    event: Object.freeze({
      kind: typeof __ev.kind === "string" ? __ev.kind : "manual",
      button: pressed,
    }),
    costs: {
      query: (query) => rpc("graph.costs.query", { query: query || {} }),
    },
    resources: {
      list: (filter) => rpc("graph.resources.list", { filter: filter || {} }),
    },
    metrics: (resourceId, opts) => rpc("graph.metrics", Object.assign({ resourceId }, opts || {})),
    data: {
      // The dts promises null (not undefined) for a key that was never set.
      get: (key) => rpc("graph.data.get", { key }).then((v) => (v === undefined ? null : v)),
      set: (key, value) => rpc("graph.data.set", { key, valueJson: JSON.stringify(value === undefined ? null : value) }),
      delete: (key) => rpc("graph.data.delete", { key }),
      list: () => rpc("graph.data.list", {}),
    },
    render: (spec) => {
      if (!spec || typeof spec !== "object") {
        throw new Error("graph.render(spec): spec must be an object with a chart.");
      }
      renderSpec = spec;
      rendered = true;
    },
    log: graphLog,
  };

  ${GUEST_FETCH}

  globalThis.fetch = fetchImpl;

  ${GUEST_CONSOLE}
})();
`;

/**
 * Submits the recorded render after the body settles. Failures here are real
 * failures (an invalid spec must not read as a rendered graph), so they go
 * through the same `__error` sentinel as a body throw.
 */
export const GRAPH_EPILOGUE = [
  `try {`,
  `  if (globalThis.__graphSubmit) await globalThis.__graphSubmit();`,
  `} catch (e) {`,
  `  await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
  `}`,
].join("\n");

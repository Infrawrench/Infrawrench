/**
 * The Infrafile half of the guest program: the `defineInfra` global the file
 * calls, and the epilogue that drives its stages.
 *
 * This is appended *after* the workflow PRELUDE, so `infra.*`, `fetch`, and
 * `console` behave identically inside an Infrafile — a plan or deploy stage is
 * ordinary workflow code that happens to be wrapped in a function.
 *
 * The stage driver is the interesting part. Each stage boundary is a host RPC,
 * which means the host decides what happens between stages: it validates the
 * env, records the plan, runs the Docker build (outside the isolate — that is
 * the whole reason the build is an RPC rather than guest code), and can stop the
 * run after `plan()` for a plan-only preview.
 */

/** Installs `globalThis.defineInfra`. Injected before the user's file runs. */
export const INFRAFILE_PRELUDE = String.raw`
(() => {
  const rpc = async (method, args) => {
    const raw = await __host(method, JSON.stringify(args || {}));
    return raw === undefined || raw === null || raw === "" ? undefined : JSON.parse(raw);
  };

  // The definition the file registers. Read by the epilogue below.
  globalThis.__infraDefinition = null;
  globalThis.defineInfra = (def) => {
    if (globalThis.__infraDefinition) {
      throw new Error("defineInfra() was called more than once — an Infrafile declares exactly one.");
    }
    if (!def || typeof def !== "object") {
      throw new Error("defineInfra() expects an object.");
    }
    if (!Array.isArray(def.envs) || def.envs.length === 0) {
      throw new Error("defineInfra(): 'envs' must be a non-empty array of environment names.");
    }
    for (const e of def.envs) {
      if (typeof e !== "string" || !e) throw new Error("defineInfra(): every entry in 'envs' must be a non-empty string.");
    }
    if (typeof def.plan !== "function") throw new Error("defineInfra(): 'plan' must be a function.");
    if (typeof def.dockerfile !== "function") throw new Error("defineInfra(): 'dockerfile' must be a function.");
    if (typeof def.deploy !== "function") throw new Error("defineInfra(): 'deploy' must be a function.");
    if (def.destroy !== undefined && typeof def.destroy !== "function") {
      throw new Error("defineInfra(): 'destroy', when present, must be a function.");
    }
    globalThis.__infraDefinition = def;
  };

  // Ask the operator to choose one of 'items'. The key is what makes a deploy
  // scriptable: --set <key>=<value> (or a saved answer) resolves it without a
  // prompt, so the same Infrafile runs in CI. Values are labels rather than
  // indices for exactly that reason — "--set build-host=web-01" beats "=2".
  const labelOf = (item, i) => {
    if (item === null || item === undefined) return String(i);
    if (typeof item === "string") return item;
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    return String(item.label || item.displayName || item.name || item.id || i);
  };
  globalThis.__infraSelect = async (key, label, items) => {
    if (typeof key !== "string" || !key) {
      throw new Error("select(key, label, items): 'key' must be a non-empty string — it is what --set targets.");
    }
    const list = Array.from(items || []);
    if (list.length === 0) throw new Error("select(" + JSON.stringify(key) + ", …): no options to choose from.");
    // Disambiguate repeats so a chosen value maps back to exactly one item.
    // Null-prototype: a resource legitimately named "constructor" or "toString"
    // would otherwise read a truthy inherited value and mangle its own label.
    const seen = Object.create(null);
    const options = list.map((item, i) => {
      const base = labelOf(item, i);
      const n = (seen[base] || 0) + 1;
      seen[base] = n;
      const l = n === 1 ? base : base + " (" + n + ")";
      // Display-only decoration: a region's flag and location ride beside the
      // label, while the answer (and --set) stays the stable label itself.
      // A hint that merely repeats the label (a region the catalog doesn't
      // know) is noise, not decoration.
      const hint =
        item && typeof item === "object"
          ? [item.flag, item.location].filter(Boolean).join(" ")
          : "";
      return hint && hint !== base ? { label: l, value: l, hint } : { label: l, value: l };
    });
    const chosen = await rpc("infrafile.select", { key, label: label || key, options });
    let idx = options.findIndex((o) => o.value === chosen);
    // A preset (--set / stored) answer may also name an item's stable id —
    // "fra1" for a region whose display label is "Frankfurt 1". Labels win
    // when both could match; ids only break the tie labels can't settle.
    if (idx < 0) {
      idx = list.findIndex((item) => item && typeof item === "object" && item.id === chosen);
    }
    if (idx < 0) {
      throw new Error(
        "select(" + JSON.stringify(key) + "): " + JSON.stringify(String(chosen)) +
        " is not one of: " + options.map((o) => o.value).join(", "),
      );
    }
    // Return the ORIGINAL item, so a picked resource keeps its methods.
    return list[idx];
  };
})();
`;

/**
 * Drives the stages. Appended after the user's file has been evaluated (so
 * `defineInfra` has run), inside the same async task the workflow runner uses.
 *
 * Note that `deploy()` receives real resource handles from `infra.*`, so a
 * deploy can apply Kubernetes manifests, read outputs, or SSH — everything a
 * workflow can do. The three helpers it gets on top (`push`, `copyTo`, `notes`)
 * are the parts that need the host's build machinery.
 */
export const INFRAFILE_EPILOGUE = String.raw`
{
  const rpc = async (method, args) => {
    const raw = await __host(method, JSON.stringify(args || {}));
    return raw === undefined || raw === null || raw === "" ? undefined : JSON.parse(raw);
  };

  const def = globalThis.__infraDefinition;
  if (!def) {
    throw new Error("This Infrafile never called defineInfra({ envs, plan, dockerfile, deploy }).");
  }

  // Hand the declared envs to the host, which picks the one to run (and
  // rejects an env the file doesn't declare, naming the ones it does).
  const chosen = await rpc("infrafile.envs", { envs: def.envs });
  const env = chosen.env;
  const git = chosen.git || {};

  // A rollback ships an artifact that already exists, so there is nothing to
  // plan, render or build: replay deploy() with the recorded plan and image.
  const rollback = chosen.rollback;

  const deployCtx = (plan, image, digest) => ({
    env,
    plan,
    git,
    image,
    digest,
    // The plan's reserved "registry" key is the documented docker-login
    // credential for the push — a bare push() must use it, not push
    // unauthenticated. An explicit second argument still overrides.
    push: (i, registry) =>
      rpc("infrafile.push", { image: i || image, registry: registry || (plan && plan.registry) }),
    copyTo: (target, remotePath) => rpc("infrafile.copyTo", { target, remotePath }),
    notes: (text) => rpc("infrafile.note", { text: String(text == null ? "" : text) }),
    // Run a command inside the image we just built, with the project mounted.
    // This is how an Infrafile ships something that isn't a container: the
    // image is the toolchain, and the command is "wrangler deploy" or similar.
    run: async (command, opts) => {
      opts = opts || {};
      const res = await rpc("infrafile.run", {
        image: opts.image || image,
        command,
        env: opts.env,
        entrypoint: opts.entrypoint,
        workdir: opts.workdir,
        mountSource: opts.mountSource,
        allowFailure: opts.allowFailure,
      });
      return opts.allowFailure ? res : res.stdout;
    },
  });

  // Tearing down needs no image and no fresh plan — but it does get the LAST
  // successful deploy's recorded plan for this env, when the host found one.
  // That is deliberately state, not a question: destroy() never prompts (a
  // preview teardown fires from a closed pull request with nobody at a
  // terminal), so anything env and git cannot name must have been written down
  // by the deploy that created it. The plan is recorded JSON — plain data, not
  // live handles.
  if (chosen.destroy) {
    if (typeof def.destroy !== "function") {
      throw new Error(
        "This Infrafile has no destroy() stage, so its preview environments cannot be torn down. " +
          "Add destroy({ env, git }) to defineInfra.",
      );
    }
    await def.destroy({
      env,
      git,
      plan: chosen.plan,
      notes: (text) => rpc("infrafile.note", { text: String(text == null ? "" : text) }),
    });
    return;
  }

  if (rollback) {
    await def.deploy(deployCtx(rollback.plan || {}, rollback.image, rollback.digest));
    return;
  }

  const planCtx = {
    env,
    git,
    // True on a --plan preview: writes through infra.accounts become recorded
    // planned changes, so plan() can skip waits that need a real resource.
    dryRun: chosen.planOnly === true,
    select: (key, label, items) => globalThis.__infraSelect(key, label, items),
    // Free-form questions, keyed exactly like select so --set answers them too.
    // The host validates and coerces, so what comes back is already the right
    // type: a number is a number, a date is YYYY-MM-DD.
    ask: (key, label, opts) => {
      opts = opts || {};
      return rpc("infrafile.ask", {
        spec: {
          key,
          label: label || key,
          kind: opts.kind || "text",
          defaultValue: opts.default === undefined ? undefined : String(opts.default),
          required: opts.required,
          min: opts.min,
          max: opts.max,
          pattern: opts.pattern,
        },
      });
    },
  };
  const plan = (await def.plan(planCtx)) || {};

  // JSON.stringify drops the methods the prelude mixed onto a resource, so a
  // resource returned as plan.buildOn arrives host-side as its plain identifying
  // fields. That is why plan results need no special marshalling.
  const cont = await rpc("infrafile.plan", { plan });
  if (cont && cont.proceed === false) {
    // Plan-only: render the Dockerfile too, since previewing it is the point.
    const preview = def.dockerfile({ env, plan });
    await rpc("infrafile.dockerfile", { dockerfile: String(preview == null ? "" : preview) });
  } else {
    const rendered = def.dockerfile({ env, plan });
    if (typeof rendered !== "string" || !rendered.trim()) {
      throw new Error("dockerfile({ env, plan }) must return a non-empty string.");
    }
    await rpc("infrafile.dockerfile", { dockerfile: rendered });

    // The build runs OUTSIDE the isolate. This RPC blocks for its whole
    // duration and is excluded from the execution budget (see run.ts).
    const built = await rpc("infrafile.build", { dockerfile: rendered, env, plan });

    await def.deploy(deployCtx(plan, built.image, built.digest));
  }
}
`;

/**
 * JavaScript source injected into the sandbox before the user's workflow runs.
 * It builds `globalThis.infra` from two host-provided globals:
 *
 *   - `__host(method, argsJson)` — async RPC into the host (returns a JSON string)
 *   - `__accountsTree` — JSON string of WorkflowPluginInfo[] (accounts by plugin)
 *   - `__metrics` — JSON string of the declared metrics' current values
 *   - `__event` — JSON string describing what triggered this run
 *
 * Keeping the ergonomic object graph in pure JS here (rather than marshalling a
 * deep object across the WASM boundary) makes the bridge robust and trivially
 * typeable — the generated infra.d.ts mirrors exactly the shape built below.
 */
import { GUEST_CODECS, GUEST_CONSOLE, GUEST_FETCH } from "./guest-lib.js";

export const PRELUDE = String.raw`
(() => {
  const rpc = async (method, args) => {
    const raw = await __host(method, JSON.stringify(args || {}));
    return raw === undefined || raw === null || raw === "" ? undefined : JSON.parse(raw);
  };

  ${GUEST_CODECS}

  // A streaming SSH command, demuxed into separate stdout/stderr readables.
  // The returned object: { stdout, stderr } each async-iterable (+ getReader()),
  // and is itself async-iterable over stdout (back-compat). A single host poll
  // returns whatever stdout/stderr accumulated; a shared pump distributes it.
  const makeSshStreams = (base) => {
    let streamId = null;
    let started = null;
    let done = false;
    let pumping = null;
    const outQ = [];
    const errQ = [];
    const ensure = async () => {
      if (!started) started = rpc("ssh.streamStart", base).then((r) => { streamId = r.streamId; });
      await started;
    };
    const pump = async () => {
      await ensure();
      const chunk = await rpc("ssh.streamRead", { streamId });
      if (!chunk) { done = true; return; }
      if (chunk.stdoutBase64) outQ.push(b64(chunk.stdoutBase64));
      if (chunk.stderrBase64) errQ.push(b64(chunk.stderrBase64));
      if (chunk.done) done = true;
    };
    const pumpOnce = () => {
      if (!pumping) pumping = pump().then(() => { pumping = null; }, (e) => { pumping = null; done = true; throw e; });
      return pumping;
    };
    const close = async () => { if (streamId) { try { await rpc("ssh.streamClose", { streamId }); } catch (e) {} } };
    const reader = (queue) => ({
      async next() {
        while (queue.length === 0 && !done) await pumpOnce();
        if (queue.length > 0) return { value: queue.shift(), done: false };
        return { value: undefined, done: true };
      },
      async return(value) { await close(); return { value, done: true }; },
    });
    const channel = (queue) => ({
      [Symbol.asyncIterator]: () => reader(queue),
      getReader() {
        const it = reader(queue);
        return { read: () => it.next(), releaseLock() {}, cancel: () => close() };
      },
    });
    return {
      __sshStream: true,
      stdout: channel(outQ),
      stderr: channel(errQ),
      [Symbol.asyncIterator]: () => reader(outQ),
    };
  };

  // SSH ops mixed onto every resource: a single combined ssh(command, opts)
  // that resolves the full output (string, or Uint8Array when encoding:"binary")
  // or — when opts.stream is set — returns an { stdout, stderr } streams object.
  const makeSshOps = (accountId, typeId, resourceId, defaultSshKey) => {
    const baseFor = (command, opts) => ({
      accountId, typeId, resourceId, command,
      // Fall back to the key attached at create time (if any) so a freshly
      // created resource can ssh() without re-specifying the key.
      sshKeyId: opts.sshKey || defaultSshKey,
      username: opts.username, timeoutMs: opts.timeoutMs,
      skipHostKeyCheck: opts.skipHostKeyCheck,
    });
    const ssh = (command, opts) => {
      opts = opts || {};
      if (opts.stream) return makeSshStreams(baseFor(command, opts));
      return rpc("ssh.exec", baseFor(command, opts)).then((r) => {
        if (r.code !== 0) throw new Error("ssh command exited with code " + r.code + ": " + utf8(b64(r.stderrBase64)));
        const bytes = b64(r.stdoutBase64);
        return opts.encoding === "binary" ? bytes : utf8(bytes);
      });
    };
    const waitUntilReachable = (opts) => {
      opts = opts || {};
      return rpc("ssh.probe", { accountId, typeId, resourceId, port: opts.port, timeoutMs: opts.timeoutMs }).then((ok) => {
        if (!ok) throw new Error("Resource did not become SSH-reachable in time");
      });
    };
    // SFTP file operations over the same SSH config (key defaults to the one
    // attached at create time). list/get/put/mkdir/delete.
    const sftpBase = (opts) => {
      opts = opts || {};
      return { accountId, typeId, resourceId, sshKeyId: opts.sshKey || defaultSshKey, username: opts.username };
    };
    const sftp = {
      list: (path, opts) => rpc("sftp.list", Object.assign(sftpBase(opts), { path: path || "." })),
      get: (path, opts) =>
        rpc("sftp.get", Object.assign(sftpBase(opts), { path })).then((r) =>
          opts && opts.encoding === "utf8" ? utf8(b64(r.base64)) : b64(r.base64),
        ),
      put: (path, data, opts) => rpc("sftp.put", Object.assign(sftpBase(opts), { path, base64: b64enc(toBytes(data)) })),
      mkdir: (path, opts) => rpc("sftp.mkdir", Object.assign(sftpBase(opts), { path })),
      delete: (path, opts) => rpc("sftp.delete", Object.assign(sftpBase(opts), { path, isDir: !!(opts && opts.recursive) })),
    };
    return { ssh, waitUntilReachable, sftp };
  };

  // Extended per-resource capabilities (plugin-client passthroughs): SQL query,
  // KV browser, NoSQL commands, k8s logs/describe, manifest, pub/sub, metrics.
  // Each throws a clear error at runtime if the owning plugin doesn't support it.
  // The optional "sidecar" routes every call through a peer plugin reached via
  // a parent resource — see makeSidecars. It rides along on each RPC; the host
  // builds the peer client from the parent's outputs.
  const makeResourceCaps = (accountId, typeId, resourceId, sidecar) => ({
    query: (sql) => rpc("resource.query", { accountId, resourceId, sql, sidecar }),
    kv: {
      list: (params) => rpc("kv.list", { accountId, typeId, resourceId, params: params || {}, sidecar }),
      get: (key) => rpc("kv.get", { accountId, typeId, resourceId, key, sidecar }),
      set: (key, value) => rpc("kv.put", { accountId, typeId, resourceId, key, value: typeof value === "string" ? value : JSON.stringify(value), sidecar }),
      delete: (key) => rpc("kv.delete", { accountId, typeId, resourceId, key, sidecar }),
    },
    nosql: (command, args) => rpc("resource.nosql", { accountId, typeId, resourceId, command, args: args || [], sidecar }),
    logs: (params) => rpc("resource.logs", { accountId, typeId, resourceId, params: params || {}, sidecar }),
    describe: () => rpc("resource.describe", { accountId, typeId, resourceId, sidecar }),
    getManifest: () => rpc("resource.getManifest", { accountId, resourceId, sidecar }),
    applyManifest: (manifest) => rpc("resource.applyManifest", { accountId, resourceId, manifest, sidecar }),
    publish: (payload) => rpc("resource.publish", { accountId, typeId, resourceId, payload: typeof payload === "string" ? { body: payload } : payload, sidecar }),
    metrics: (timeRange) => rpc("resource.metrics", { accountId, typeId, resourceId, timeRange, sidecar }),
  });

  // Object-read ops bound to one bucket, mixed onto a storage-capable
  // resource so e.g. (await cf.getR2Bucket("configs")).get("app.json") works.
  const bucketOf = (r) =>
    (r && (r.externalId || (r.id ? String(r.id).split(":").pop() : ""))) || "";
  const makeStorageOps = (accountId, bucket) => ({
    list: (prefix) => rpc("storage.list", { accountId, bucket, prefix: prefix || "" }),
    get: async (key) => {
      const body = await rpc("storage.get", { accountId, bucket, key });
      return {
        base64: body.base64,
        text: () => body.text,
        json: () => JSON.parse(body.text),
      };
    },
  });

  const makeResourceHandle = (accountId, typeId, sidecar) => ({
    list: () => rpc("resource.list", { accountId, typeId, sidecar }),
    get: (externalId) => rpc("resource.get", { accountId, typeId, externalId, sidecar }),
    create: (fields, parentResourceId) =>
      rpc("resource.create", { accountId, typeId, fields: fields || {}, parentResourceId, sidecar }),
    update: (resourceId, fields) =>
      rpc("resource.update", { accountId, typeId, resourceId, fields: fields || {}, sidecar }),
    delete: (resourceId) => rpc("resource.delete", { accountId, typeId, resourceId, sidecar }),
  });

  // camelCase: first word fully lowercased (leading acronyms read naturally:
  // "DNS Records" → "dnsRecords"), following words capitalized. MUST match
  // codegen's camelCase so group names line up with the generated typings.
  const camel = (s) => {
    const words = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (words.length === 0) return "";
    const tail = words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
    return words[0].toLowerCase() + tail;
  };

  // One resource-type group — { list, get, create?, update?, delete? } — bound
  // to an account, and optionally reached through a sidecar (see below).
  const makeGroup = (accountId, rt, sidecar) => {
    const h = makeResourceHandle(accountId, rt.id, sidecar);
    // Every resource gets ssh()/waitUntilReachable(); storage-capable types
    // additionally get bucket-read ops. The resource's canonical id (r.id) is
    // what the host resolves outputs (e.g. the SSH host) against.
    //
    // Sidecar resources get the plugin-client capabilities (logs, describe,
    // manifest, …) but NOT ssh/sftp or bucket ops: both of those resolve
    // against the account's own plugin — an SSH endpoint, a bucket name — which
    // something living inside somebody else's cluster doesn't have.
    const wrap = (r) => {
      if (!r) return r;
      const augmented = Object.assign(
        {},
        r,
        sidecar ? {} : makeSshOps(accountId, rt.id, r.id, r.sshKeyRef),
        makeResourceCaps(accountId, rt.id, r.id, sidecar),
        {
          // Delete this very resource (by its own id). The host rejects if the
          // owning plugin doesn't support deletion.
          delete: () => h.delete(r.id),
        },
      );
      if (rt.storage && !sidecar) Object.assign(augmented, makeStorageOps(accountId, bucketOf(r)));
      if (!sidecar) {
        // Peer plugins reachable through this resource. Never overwrite a field
        // the provider already returned under the same name.
        const peers = makeSidecars(accountId, rt, r.id);
        for (const key of Object.keys(peers)) {
          if (!(key in augmented)) augmented[key] = peers[key];
        }
      }
      return augmented;
    };
    const g = {
      list: async () => (await h.list()).map(wrap),
      get: async (externalId) => wrap(await h.get(externalId)),
    };
    if (rt.supportsCreate) {
      g.create = async (fields, parentResourceId) => wrap(await h.create(fields, parentResourceId));
      // The provider's region list with display metadata (flag, location) —
      // hand it to select() and the picker reads like the GUI's. Sidecars have
      // no create form of their own to source it from.
      if (!sidecar) g.regions = () => rpc("resource.regions", { accountId, typeId: rt.id });
    }
    if (rt.supportsUpdate)
      g.update = async (resourceId, fields) => wrap(await h.update(resourceId, fields));
    if (rt.supportsDelete) g.delete = (resourceId) => h.delete(resourceId);
    return g;
  };

  // Peer plugins reached *through* a resource rather than through an account of
  // their own: a managed cluster exposes kubernetes via its kubeconfig, a
  // managed database exposes postgres/mysql/redis/mongodb via its connection
  // string. Keyed by plugin id, so this reads
  //   cluster.kubernetes.pods.list()
  // Sidecars never nest — a peer's own types carry none — so this terminates.
  const makeSidecars = (accountId, rt, parentResourceId) => {
    const out = {};
    for (const sc of rt.sidecars || []) {
      if (!sc.pluginId || sc.pluginId in out) continue;
      const groups = {
        // Apply arbitrary (multi-document) YAML inside this resource's peer
        // plugin (kubectl apply -f into a managed cluster).
        importYaml: (yaml) =>
          rpc("account.importYaml", {
            accountId,
            yaml,
            sidecar: { pluginId: sc.pluginId, parentResourceId },
          }),
      };
      for (const srt of sc.resourceTypes || []) {
        const group = camel(srt.pluralDisplayName);
        if (!group || group in groups) continue;
        groups[group] = makeGroup(accountId, srt, {
          pluginId: sc.pluginId,
          parentResourceId,
        });
      }
      out[sc.pluginId] = groups;
    }
    return out;
  };

  const makeAccountHandle = (acc, resourceTypes) => {
    const handle = {
      id: acc.id,
      pluginId: acc.pluginId,
      displayName: acc.displayName,
      resolveOutput: (typeId, resourceId, outputKey) =>
        rpc("resource.resolveOutput", { accountId: acc.id, typeId, resourceId, outputKey }),
      // Apply arbitrary (multi-document) YAML to this account (kubectl apply -f).
      importYaml: (yaml) => rpc("account.importYaml", { accountId: acc.id, yaml }),
    };
    for (const rt of resourceTypes) {
      const group = camel(rt.pluralDisplayName);
      if (!group || group in handle) continue;
      handle[group] = makeGroup(acc.id, rt);
    }
    return handle;
  };

  const tree = JSON.parse(__accountsTree);
  const accounts = {};
  for (const p of tree) {
    const list = p.accounts;
    const rts = p.resourceTypes;
    const make = (acc) => makeAccountHandle(acc, rts);
    accounts[p.pluginId] = {
      list: () => list.map(make),
      getById: (id) => {
        const a = list.find((x) => x.id === id);
        if (!a) throw new Error("No " + p.pluginId + " account with id " + id);
        return make(a);
      },
      getByName: (name) => {
        const a = list.find((x) => x.displayName === name);
        if (!a) throw new Error("No " + p.pluginId + " account named " + name);
        return make(a);
      },
    };
  }

  const log = (level) => (...parts) => rpc("log", { level, message: fmtParts(parts) });

  // Stream an SSH streams object to the run log line-by-line: stdout at "info"
  // and stderr at "error" (rendered red), as output arrives.
  const streamToLog = async (streams) => {
    const drain = async (readable, level) => {
      let buf = "";
      for await (const chunk of readable) {
        buf += typeof chunk === "string" ? chunk : utf8(chunk);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          await rpc("log", { level, message: buf.slice(0, nl) });
          buf = buf.slice(nl + 1);
        }
      }
      if (buf.length) await rpc("log", { level, message: buf });
    };
    await Promise.all([drain(streams.stdout, "info"), drain(streams.stderr, "error")]);
  };

  // infra.log: awaits any promise arguments first (so you can pass an unawaited
  // ssh()/sftp.get() call straight in), then — if handed an SSH streams object —
  // streams it; otherwise logs a line. Byte buffers are decoded as UTF-8.
  const infraLog = async (...parts) => {
    const resolved = await Promise.all(parts);
    if (resolved.length === 1 && resolved[0] && resolved[0].__sshStream) return streamToLog(resolved[0]);
    return rpc("log", { level: "info", message: fmtParts(resolved) });
  };

  // Metrics are exposed as direct typed properties (infra.metrics.<key>): reads
  // come from a snapshot taken at run start; writes update the snapshot and are
  // buffered, then persisted once (final value per key) after the run via
  // globalThis.__flushMetrics (see sandbox buildProgram). Property setters can't
  // be async, hence the deferred flush.
  const metricState = (() => { try { return JSON.parse(__metrics || "{}"); } catch (e) { return {}; } })();
  const metricDirty = new Set();
  const metrics = new Proxy(metricState, {
    get: (t, k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : (typeof k === "string" ? null : undefined)),
    set: (t, k, v) => {
      if (typeof k !== "string") return false;
      t[k] = v;
      metricDirty.add(k);
      return true;
    },
  });
  globalThis.__flushMetrics = async () => {
    for (const k of metricDirty) {
      await rpc("metric.set", { key: k, value: metricState[k] });
    }
    metricDirty.clear();
  };

  // What kicked off this run. Frozen: it describes the past, and a workflow
  // mutating it would only confuse a later read of the same object.
  const event = Object.freeze((() => {
    try { return JSON.parse(__event || '{"kind":"manual"}'); } catch (e) { return { kind: "manual" }; }
  })());

  // Report spend from a source Infrawrench has no plugin for. Accepts one row
  // or an array so a single-row write reads naturally; chunked so a workflow
  // backfilling a year doesn't build one enormous RPC payload.
  const COST_CHUNK = 1000;
  const costs = {
    write: async (rows) => {
      const all = Array.isArray(rows) ? rows : [rows];
      let written = 0;
      for (let i = 0; i < all.length; i += COST_CHUNK) {
        const res = await rpc("costs.write", { rows: all.slice(i, i + COST_CHUNK) });
        written += (res && res.written) || 0;
      }
      return { written };
    },
  };

  ${GUEST_FETCH}

  // Raise an alert to whoever owns this workflow. Accepts either
  // page("text", opts) or page({ message, ... }) so the common case stays one
  // argument. Throttling lives host-side (keyed, so it holds across runs).
  const page = (messageOrSpec, opts) => {
    const spec = typeof messageOrSpec === "string"
      ? Object.assign({}, opts || {}, { message: messageOrSpec })
      : (messageOrSpec || {});
    return rpc("page", { spec });
  };
  // Re-arm a key after the condition it alerted on recovered, so the next
  // occurrence pages immediately instead of waiting out a stale cooldown.
  page.clear = (key) => rpc("page.clear", { key });

  // Suspend the run until an org member approves or denies. Accepts either
  // waitForApproval("text", opts) or waitForApproval({ message, ... }) so the
  // common case stays one argument. Denial/timeout reject host-side, so an
  // unhandled deny fails the run.
  const waitForApproval = (messageOrSpec, opts) => {
    const spec = typeof messageOrSpec === "string"
      ? Object.assign({}, opts || {}, { message: messageOrSpec })
      : (messageOrSpec || {});
    return rpc("approval.wait", { spec });
  };

  globalThis.infra = {
    accounts,
    prompt: (spec) => rpc("prompt", { spec: typeof spec === "string" ? { message: spec } : spec }),
    metrics,
    event,
    costs,
    page,
    waitForApproval,
    output: (value) => rpc("output", { value }),
    log: infraLog,
  };

  // HTTP is a global, not an infra.* method: a workflow that talks to an API
  // should read like every other bit of JavaScript that talks to an API.
  globalThis.fetch = fetchImpl;

  ${GUEST_CONSOLE}
})();
`;

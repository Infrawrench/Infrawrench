/**
 * Which replica is holding an in-process session.
 *
 * Several features keep something in one pod's memory that cannot be moved:
 * the ssh2 stream behind a shared console, the bastion agent registry, and the
 * compositor connection behind a Linux application session. The pod that
 * opened it is the only one that can serve the next request about it, and with
 * `replicas: 2` and round-robin routing roughly half of those requests arrive
 * somewhere else.
 *
 * `infra/k8s/web-ws-ingress.yaml` solves the browser half by consistent-
 * hashing `?sid=` at the ingress, and says plainly that the durable fix is "a
 * cross-replica relay". This table is the registry that relay routes on: a
 * lease saying *which* pod holds a session, so any other pod can forward to it
 * instead of trying to start a second one.
 *
 * It is deliberately not an authorisation record and holds nothing secret. An
 * address here is a routing hint and never a capability: the permission check
 * happens on the pod the request arrived at, before anything is forwarded, and
 * the receiving pod authenticates its sibling with a shared secret rather than
 * re-deriving a user's rights. `api/routes/internal-relay.ts` sets out why
 * that is the right boundary and what stops it being the only one.
 *
 * The lease is heartbeat-based rather than deleted-on-exit, because the case
 * that matters most is the one where no cleanup runs — a pod that is OOM
 * killed, evicted mid-rollout, or partitioned. A row whose `heartbeatAt` has
 * gone stale is claimable by anybody; see `services/replica-relay.ts` for the
 * single statement that does it.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const replicaSessionOwners = pgTable(
  "replica_session_owners",
  {
    /** `${kind}:${key}` — the session this row leases. */
    id: text("id").primaryKey(),
    /** The feature the session belongs to, e.g. `linux-app`. */
    kind: text("kind").notNull(),
    /** `host:port` of the pod holding it, reachable inside the cluster. */
    ownerAddress: text("owner_address").notNull(),
    claimedAt: timestamp("claimed_at").notNull().defaultNow(),
    /**
     * Refreshed every time the owner serves a call. A lease older than
     * `LEASE_TTL_MS` is treated as abandoned, so a pod that died without
     * releasing anything does not strand a session until someone notices.
     */
    heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
  },
  (t) => ({
    // Reaping and "what is this pod still holding" both scan on recency.
    heartbeatIdx: index("replica_session_owners_heartbeat_idx").on(t.heartbeatAt),
    ownerIdx: index("replica_session_owners_owner_idx").on(t.ownerAddress),
  }),
);

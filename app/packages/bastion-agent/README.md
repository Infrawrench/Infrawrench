# `@infrawrench/bastion-agent`

Tiny outbound agent that lets Infrawrench route a cloud account's control-plane API traffic through your own infrastructure.

The agent **dials outbound** over WSS to the Infrawrench backend, so it works behind NAT and doesn't need any inbound firewall changes. The backend multiplexes per-request TCP streams over the single WebSocket; the agent opens each stream against the allowlisted destination it was told about at connect time and forwards bytes both ways.

End-to-end TLS terminates between the backend (TLS client) and the cloud provider's API (TLS server). The agent only sees opaque encrypted bytes — it never holds or inspects cloud credentials.

## Running it

In the Infrawrench web app go to **Settings → Bastions → New Bastion**. You'll receive a one-time enrollment token and a `docker run` command:

```
docker run -d \
  --name infrawrench-bastion \
  --restart unless-stopped \
  -e BASTION_TOKEN=iwb_… \
  -e INFRAWRENCH_URL=wss://app.infrawrench.com/api/bastions/agent \
  ghcr.io/infrawrench/bastion-agent:latest
```

The token cannot be recovered after the modal closes — copy it now. To rotate, revoke the bastion in the UI and create a new one.

## What it does (and doesn't)

- ✅ Opens TCP streams **only to hostnames the backend allowlists** at handshake time. The allowlist is derived from the plugins of accounts bound to this bastion.
- ✅ Forwards bytes; lets the backend handle TLS to the cloud API.
- ✅ Reconnects with exponential backoff if the WebSocket drops.
- ❌ Does not accept inbound connections.
- ❌ Does not see or store credentials.
- ❌ Does not need disk — restart-safe, stateless.

## Environment

| Variable               | Required | Default | Notes                                          |
| ---------------------- | -------- | ------- | ---------------------------------------------- |
| `BASTION_TOKEN`        | yes      |         | The `iwb_…` token from the UI.                 |
| `INFRAWRENCH_URL`      | yes      |         | `wss://…/api/bastions/agent`                   |
| `HEARTBEAT_TIMEOUT_MS` | no       | `60000` | Force-close the WS if the backend goes silent. |
| `VERBOSE`              | no       | `0`     | Set to `1` for per-stream open/close logs.     |

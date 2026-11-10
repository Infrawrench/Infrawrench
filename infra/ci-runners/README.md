# CI runner hosts

Terraform for the machines that run `iwci serve` (`ci-runner/`), reached
over SSH, and for telling the CI proxy (`app/packages/ci-proxy`) about
them. It is its own root, with its own state, so a production apply never
connects to a runner and a runner change never plans production. It uses
no providers: `terraform_data` and SSH, plus `curl` for the proxy.

```sh
cd infra/ci-runners
cp terraform.tfvars.example terraform.tfvars   # fill it in
terraform init
terraform apply
```

## What happens on each host

`files/install.sh`, run with sudo, which is idempotent:

- creates an `iwci` system user, `/opt/iwci/bin`, `/var/lib/iwci/cache` and
  `/etc/iwci/iwci.env` (mode 0640, the server key and R2 credentials);
- installs the uploaded `iwci` **only if the host has none**. After that the
  runner keeps itself current from its release channel, and an older upload
  must not undo that;
- writes `iwci.service`: runs as `iwci`, `ProtectSystem=strict` with only
  its binary directory and cache writable, restarts on failure, and stops
  with SIGTERM and a 65-minute timeout;
- keeps core dumps: installs `systemd-coredump` and `gdb` (with apt),
  turns off Ubuntu's apport so it cannot take the kernel's core pattern back
  at boot, and the unit sets `LimitCORE=infinity`. Every Node job runs in
  the runner's own process, so a fault in one crashes the runner;
  `coredumpctl list iwci` and `coredumpctl gdb iwci` read what it left
  (#947);
- optionally installs `cloudflared` with a tunnel token (Debian or Ubuntu,
  from Cloudflare's signed apt repository), so the runner needs no open port;
- starts the service, or restarts it without waiting when it was running.

A host is re-provisioned when its configuration, the unit, the install
script or its tunnel token changes. Secrets are hashed into the trigger, so
the state holds only digests.

## Restarts and updates never kill a job

`iwci serve` treats SIGTERM as "drain": it stops taking runs (the proxy sees
`draining` in `/v1/capacity` and places work elsewhere), lets running ones
finish, then exits. So a configuration change, `systemctl restart`, or
removing a host from `hosts` all wait for running jobs.

New versions do not go through Terraform at all. Each runner reads
`releases/iwci/channels/<update_channel>.json` from R2 every five minutes.
That manifest must be signed by the release key (`release_public_key`),
because every host's R2 credentials can write to the bucket and an unsigned
channel would let one host push a binary to all of them. When the channel
names another version, the runner downloads it, checks its signed size and
sha256 and that it runs, drains, and `exec`s it with the same arguments.
The process id and the unit stay the same.

Releases come from `.github/workflows/ci-runner-release.yml`: bump
`ci-runner/VERSION` and merge. To roll back, point the channel at the older
version (`iwci release <old binary> --version <old> --channel stable`); a
released version's binary never changes.

## The proxy's list

With `proxy_url` set, Terraform sends the whole list to `PUT /v1/runners`
once the hosts are up, and again whenever names or URLs change. Run ids
carry the runner's name (`ci-1.<id>`), so adding and removing hosts never
sends a status request to the wrong one. Without `proxy_url`, set the
proxy's `RUNNERS` variable to `ci-1=https://...,ci-2=https://...`.

## Not covered

TLS and reachability are yours: a tunnel token, or a TLS front that the
proxy can reach at `url`. The hosts need outbound HTTPS to R2 and to the git
hosts they clone from. Building `iwci` with `--features node` (for
`env:bash-node`) needs x86_64; there is no prebuilt V8 for Linux arm64.

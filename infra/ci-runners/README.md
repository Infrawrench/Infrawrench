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
- optionally sets up compressed swap in RAM (`zram` on the host, below);
- optionally installs `cloudflared` with a tunnel token (Debian or Ubuntu,
  from Cloudflare's signed apt repository), so the runner needs no open port;
- starts the service, or restarts it without waiting when it was running.

A host is re-provisioned when its configuration, the unit, the install
script or its tunnel token changes. Secrets are hashed into the trigger, so
the state holds only digests.

## Memory

By default a job reserves its `memory:` out of the runner's budget before it
starts, so the jobs running can never hold more than the budget. Jobs hold
a sixth to a quarter of what they reserve, though, and the rest queues work
behind memory nothing uses. `memory_admission = "estimate"` on a host
(`IWCI_MEMORY_ADMISSION` in its env file) has jobs reserve what they held
the last times they ran and half as much again instead; `ci-runner/README.md`
("Limits") has the rule. An estimate can be wrong, so set `zram` with it:

- `zram = "12GiB"` makes `install.sh` set up one zram swap device of that
  size (zstd, priority 100) through a unit of its own, `iwci-zram.service`,
  ordered before `iwci.service`, and sets `vm.swappiness = 150` and
  `vm.page-cluster = 0` in `/etc/sysctl.d/60-iwci-zram.conf`. The size is
  what the device takes uncompressed; the runner's memory compresses about
  3:1, so a full 12 GiB device holds about 4 GiB of RAM. Nothing is written
  to a disk.
- On a kernel without the module (Ubuntu's cloud images keep it in
  `linux-modules-extra-<kernel>`) the script installs that package for the
  running kernel. A kernel upgrade needs its own: until then the unit fails
  at boot and the runner runs without swap, which is the state it was in
  before.
- A host that already swaps to a disk keeps that swap at its lower
  priority, used once zram is full. Job memory, secrets included, can then
  reach the disk, so the script warns; `swapoff` it and take it out of
  `/etc/fstab` unless you have a reason to keep it.
- `iwci.service` has no `MemoryMax=`. If you add one, reclaim inside the
  unit swaps to zram too, but the compressed pages are not charged to the
  unit: keep `MemoryMax` plus a third of the zram size under the host's
  memory, and do not set `MemorySwapMax=0`.
- Changing the size of a device in use takes `systemctl restart iwci-zram`
  on the host, which swaps everything back in first; the install script
  does not do that under a running server. Removing `zram` from the host
  removes the unit and puts the two sysctls back.

Both settings re-provision the host, which restarts `iwci` and therefore
drains it first, like any other change here.

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

## Native jobs (gVisor), off by default

A host with `native_sandbox = true` can run native programs (Bun) in a
gVisor sandbox per job (`ci-runner/crates/iwci-sandbox`). The install
script then:

- downloads gVisor `release-20261109.0` for the host's architecture into
  `/opt/iwci/lib/gvisor-20261109.0`, checked against the SHA-512 pinned in
  the script (the same pins as `crates/iwci-sandbox/tests/fixtures.sh`);
- installs the sandbox helper, `/opt/iwci/lib/iwci-sandbox-spawn`: a
  root-owned copy of the uploaded binary (never of the installed one, which
  its user can replace), which under that name only starts gVisor's
  root-owned Sentry in new namespaces (`crates/iwci-sandbox/src/helper.rs`).
  A new upload reinstalls it; a runner whose helper protocol is newer than
  the helper's runs no native jobs until then, and says so;
- loads `files/apparmor-iwci` as `/etc/apparmor.d/iwci-sandbox-spawn`: the
  helper, and only it, may create user namespaces, which Ubuntu otherwise
  keeps from unprivileged programs. The runner's own binary gets nothing.
  The sandbox runs as an unprivileged user and drops every capability
  before it runs the job;
- writes `Delegate=memory cpu pids` into the unit, so the runner has a
  cgroup subtree of its own: it moves itself into `runner/` and gives each
  sandbox `jobs/<id>`, with `memory.max` at the job's `memory:`,
  `memory.swap.max` 0 (gVisor keeps a job's memory in one file the kernel
  would rather swap than refuse) and `pids.max`;
- sets `IWCI_SANDBOX_HELPER` in the unit to the helper, and
  `IWCI_NATIVE_SANDBOX` to that gVisor directory, which
  is what makes the runner offer native tools (`tools: [builtin:bun@1.4]`;
  `/v1/capacity` says `native_sandbox: true`).

Turning it off removes the profile and the delegation. To check a host
after applying: `aa-status | grep iwci` lists the profile; `systemctl show
iwci -p Delegate` says `memory cpu pids`; and, with the service running,
`cat /sys/fs/cgroup/system.slice/iwci.service/cgroup.subtree_control`
lists the three controllers once the runner has made `runner/`.

## Not covered

TLS and reachability are yours: a tunnel token, or a TLS front that the
proxy can reach at `url`. The hosts need outbound HTTPS to R2 and to the git
hosts they clone from. Building `iwci` with `--features node` (for
`env:bash-node`) needs the bridge's V8 archive from the runner pool's bucket
(`ci-runner/builtins/v8/archive.sh fetch`); the release channel carries
builds for both x86_64 and arm64.

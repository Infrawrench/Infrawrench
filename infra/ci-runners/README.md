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
  with SIGTERM to the runner alone (`KillMode=mixed`, so the machines and
  sandboxes in its cgroup keep running while it drains) and a timeout of 6
  hours and 5 minutes, the longest job's;
- keeps core dumps: installs `systemd-coredump` and `gdb` (with apt),
  turns off Ubuntu's apport so it cannot take the kernel's core pattern back
  at boot, and the unit sets `LimitCORE=infinity`. Every Node job runs in
  the runner's own process, so a fault in one crashes the runner;
  `coredumpctl list iwci` and `coredumpctl gdb iwci` read what it left
  (#947);
- installs `/usr/local/sbin/iwci-size`, which holds the huge page rule
  (machines, below) and, with `size = "auto"` on the host, sizes it from
  its hardware at every boot (below);
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

## Sizing from the hardware

`cpus`, `memory` and `zram` are fixed numbers, which suit a host that is
always the same machine. A host whose image boots on whatever instance type
a fleet launches (ci-2, below) sets `size = "auto"` instead, leaves `cpus`
and `memory` unset, and sets `zram = "auto"` if it wants zram. The install
script then installs `iwci-size.service`, a oneshot ordered before
`iwci-zram.service` and `iwci.service`, which runs `iwci-size boot` at
every boot, and runs it once itself. From `nproc` and `MemTotal` it sets:

| What                         | Where                                                        | Rule                                                                          |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `IWCI_CPUS`                  | `/etc/iwci/iwci.env`                                         | every online CPU                                                              |
| `IWCI_MEMORY`                | `/etc/iwci/iwci.env`                                         | 81% of `MemTotal`, whole GiB rounded down                                     |
| `IWCI_ZRAM_SIZE`             | `/etc/iwci/zram.env`, read by `iwci-zram.service`            | a fifth of `IWCI_MEMORY`, 1 to 128 GiB                                        |
| `vm.nr_overcommit_hugepages` | `/etc/sysctl.d/60-iwci-machines.conf`, where machines are on | the smaller of `IWCI_MEMORY` and three quarters of `MemTotal`, in 2 MiB pages |

The constants come from ci-2 on an m8i.16xlarge (64 vCPUs, 247.7 GiB
`MemTotal`), which ran with `cpus = 64`, `memory = "200GiB"` and
`zram = "40GiB"`; the rule gives that host the same three. What `boot`
writes for other machines:

| Host                                 | `IWCI_CPUS` | `IWCI_MEMORY` | zram   | huge pages         |
| ------------------------------------ | ----------- | ------------- | ------ | ------------------ |
| 64 vCPUs, 256 GiB (247.7 `MemTotal`) | 64          | 200GiB        | 40GiB  | 95116 (185.8 GiB)  |
| 96 cores, 384 GiB                    | 96          | 300GiB        | 60GiB  | 142675 (278.7 GiB) |
| 192 cores, 384 GiB                   | 192         | 300GiB        | 60GiB  | 142675 (278.7 GiB) |
| 192 cores, 768 GiB                   | 192         | 601GiB        | 120GiB | 285350 (557.3 GiB) |

(`MemTotal` for the larger ones taken in ci-2's proportion of the nominal
memory, 247.7 of 256 GiB; a real host's differs a little.)

`iwci-size` rewrites only those two lines of the env file, which holds the
server key and the R2 credentials: it writes a copy with the same owner and
mode, renames it over the original only when something changed, and never
prints it. `iwci-size show` prints what `boot` would set without changing
anything, and `journalctl -u iwci-size` has what it set at the last boot.
The rule is a few named constants at the top of `files/iwci-size`; its
tests run with `bash infra/ci-runners/tests/iwci-size.sh` (fake hosts in a
temporary directory, nothing applied to the machine running them), and
`.infrawrench/ci/ci-runner-hosts.yml` runs them and shellcheck on every
change here.

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
- creates the system user `iwci-sandbox`, which every Sentry runs as;
- installs the sandbox service (`sandbox_service_path`, built by
  `ci-runner/crates/iwci-sandbox-spawn/build.sh`, and only if it matches
  the SHA-256 pinned for the host's architecture in
  `ci-runner/crates/iwci-sandbox-spawn/sha256`; the build is reproducible,
  and `build.sh --check` compares one; Terraform checks before the upload,
  `install.sh` on a root-only copy before it installs it) as
  `/opt/iwci/lib/sandbox/iwci-sandbox-spawn`, with
  `files/iwci-sandbox-spawn.socket` and `files/iwci-sandbox-spawn@.service`.
  Ubuntu keeps user namespaces from unprivileged programs, so the runner
  asks this root service for each sandbox over
  `/run/iwci-sandbox-spawn.sock` (group `iwci`, mode 0660, one instance per
  connection). An instance checks the peer is `iwci`, takes a few checked
  values and the sandbox's descriptors, never a command line or an
  environment, starts only the Sentry at the pinned path once it and
  gVisor's unmounter match the SHA-256 pins compiled in, as `iwci-sandbox`
  with no supplementary group, straight into the job's cgroup (a directory
  the runner owns), becomes `iwci-sandbox` itself, and kills the Sentry
  when the runner asks or goes away (`crates/iwci-sandbox-spawn/src/service.rs`).
  The unit narrows its capabilities to what that takes and filters its
  system calls and address families; the runner keeps `NoNewPrivileges`.
  A runner of another service protocol runs no native jobs until the
  service is replaced, and says so. No AppArmor profile is involved, and
  those of earlier versions are removed;
- writes `Delegate=memory cpu pids` into the unit, so the runner has a
  cgroup subtree of its own: it moves itself into `runner/` and gives each
  sandbox `jobs/<id>`, with `memory.max` at the job's `memory:`,
  `memory.swap.max` 0 (gVisor keeps a job's memory in one file the kernel
  would rather swap than refuse) and `pids.max`;
- sets `IWCI_SANDBOX_SERVICE` in the unit to the service's socket, and
  `IWCI_NATIVE_SANDBOX` to that gVisor directory, which
  is what makes the runner offer native tools (`tools: [builtin:bun@1.4]`;
  `/v1/capacity` says `native_sandbox: true`).

Turning it off removes the service and the delegation. To check a host
after applying: `systemctl status iwci-sandbox-spawn.socket` is listening
on `/run/iwci-sandbox-spawn.sock`; `systemctl show iwci -p Delegate` says
`memory cpu pids`; and, with the service running,
`cat /sys/fs/cgroup/system.slice/iwci.service/cgroup.subtree_control`
lists the three controllers once the runner has made `runner/`.

## Virtual machines, off by default

A host with `machines = true` can run `platform: linux` jobs, each in a
QEMU/KVM virtual machine the runner starts for it
(`ci-runner/crates/iwci-vm`; the runner's README, "Platforms"). The
install script then:

- installs QEMU for the host's architecture (`qemu-system-x86` or
  `qemu-system-arm`) and `erofs-utils` from apt;
- adds `iwci` to the group `kvm`, which owns `/dev/kvm`, and the unit gets
  `SupplementaryGroups=kvm`;
- makes `/var/lib/iwci/machines` (root, group `iwci`, 0750) and sets
  `IWCI_MACHINES` in the unit to it;
- lets the kernel make 2 MiB huge pages on demand, up to the smaller of
  the memory jobs may reserve (`memory`) and three quarters of the host
  (`vm.nr_overcommit_hugepages` in
  `/etc/sysctl.d/60-iwci-machines.conf`, set by `iwci-size huge-pages`;
  with `size = "auto"`, again at every boot). Huge pages are never swapped,
  so a larger cap let machines admitted by estimate take the host's last
  page (ci-1 stopped answering with eleven running); past the cap a
  machine gets 4 KiB pages instead. A machine's memory goes in them,
  which cuts its boot from about 0.85 s to 0.36 s at 2 GiB; nothing is
  reserved until a machine starts, and its pages go back when it stops.
  A pool (`vm.nr_hugepages`) would save another 0.1 s a boot, but pins
  its memory whether or not a machine runs, so it is not set.

The image is not uploaded from here: its root is a few GB. Build it on the
host with `ci-runner/images/linux/build.sh --out /var/lib/iwci/machines/linux`
(`ci-runner/images/README.md` has what it needs). The runner lists what it can run in
`/v1/capacity` (`"platforms": ["wasm", "linux"]`) and leaves out, with a
line in its log, whatever the host lacks: KVM (on x86_64 VT-x or AMD-V, on
Graviton a `.metal` instance), the image, or a tool. On EC2, the 7th and 8th
generation Intel types (C7i, M7i, R7i, C8i, M8i, R8i and their flex
variants) offer KVM without `.metal` when launched with nested
virtualization on (`CpuOptions` `NestedVirtualization=enabled`, which the
AWS CLI before about 2.32 does not know; boto3 1.44 does). AMD's virtual
sizes (C8a, M8a, R8a) have no nested virtualization; their `.metal` sizes
give the host AMD-V directly (`kvm_amd`) and refuse the `CpuOptions`
setting. ci-2 runs on either (below). To check a host after applying: `journalctl -u iwci | grep
machines:` names anything missing, and `curl` of `/v1/capacity` on the
listen address lists the platforms.

## ci-2: AWS spot in us-east-1

ci-2 is an AWS spot instance in us-east-1, launched by an EC2 fleet from two
launch templates with the same image and settings (Ubuntu 24.04, 400 GB
gp3, security group `ci-2` with SSH from the operator only, key `pogair`):
`ci-2-metal` for the AMD bare-metal types and `ci-2` for the Intel ones.
Three things decide where it can run:

- **KVM.** Machines need `/dev/kvm`. An 8th generation Intel instance only
  has it when launched with `CpuOptions.NestedVirtualization = enabled`,
  which the `ci-2` template sets (AWS CLI 2.31 cannot set it, boto3 1.44
  can). An AMD `.metal` instance has it without that setting and refuses a
  launch that asks for it ("does not support Nested Virtualization"), which
  is why `ci-2-metal` is a template of its own without `CpuOptions`.
  Without KVM the runner offers no `linux` platform.
- **Per-core speed.** The remaining slow steps in CI are single-threaded
  (bundlers, type checkers, emulated tests). AMD's 8th generation runs at
  4.5 GHz against 3.9 GHz for the Intel types, and the same jobs in machines
  ran 15 to 35% faster on an m8a.metal-24xl than on an m8i, with machines
  booting in about 0.6 s instead of 1.2 s (no nested virtualization).
  r8a.metal-24xl was also the cheapest and steadiest spot price of the
  96-vCPU types in us-east-1 in November 2026.
- **Spot capacity.** A single type in a single zone was reclaimed about five
  times a day in us-east-2 (AWS's spot placement score for one m8i.16xlarge
  there is 1 of 10). The fleet takes, in order of priority, r8a.metal-24xl
  and m8a.metal-24xl (from `ci-2-metal`), then m8i.16xlarge, r8i.16xlarge,
  m8i.24xlarge or r8i.24xlarge (from `ci-2`), in any of five us-east-1
  zones. Its strategy, `capacity-optimized-prioritized`, honours the
  priorities only as far as capacity allows, so a reclaim can still land
  on Intel. The account's us-east-1 spot vCPU quota was raised from 32 for
  it (a metal-24xl is 96 vCPUs).
- **Sizing.** ci-2 is a `size = "auto"` host with `zram = "auto"` (above),
  so its image sizes itself at every boot and the runner uses all of
  whichever type the fleet launched: 64 vCPUs and 200 GiB on an
  m8i.16xlarge, 96 vCPUs and about 300 GiB on an m8a.metal-24xl. With the fixed
  `cpus = 64` and `memory = "200GiB"` it had before, every type ran as an
  m8i.16xlarge and a larger one left the rest idle. Only an image baked
  from a host provisioned with `size = "auto"` does this; one baked
  earlier boots with the fixed sizes it was baked with.

The fleet is of type `maintain`: when AWS takes an instance back, the fleet
launches another from the version of the matching template it names, whose
image is a snapshot of a provisioned ci-2 (runner, tunnel token, zram,
machine image), so the replacement serves CI as soon as it boots, with no
`terraform apply`. A host change made by hand (as `KillMode=mixed` was on
the 2026-11-24 host) is lost on the next replacement unless it is baked
in. The first us-east-1 host came from a one-off launch instead, was
reclaimed 26 minutes later, and CI was down for eight hours. Bake a new
image whenever the install script, the tunnel or the machine image
changes, or a replacement boots the old one. The runner updates itself
from its release channel either way. To bake:

1. Run `sudo sync` on the host. `create-image --no-reboot` snapshots the
   disk as it stands, and files written in the last minute or so are not
   on it yet: an image baked straight after a `terraform apply` on
   2026-11-25 had empty unit files for `iwci` and `iwci-size` (systemd
   reads an empty unit as masked), and the host it booted never started
   the runner.
2. `aws ec2 create-image --no-reboot` of the host, and wait until the
   image is `available` (about ten minutes for the 400 GB disk; the CLI's
   waiter gives up first).
3. A new version of **both** templates with the new `ImageId`, each made
   the default. The image boots on either vendor: Ubuntu loads `kvm_intel`
   or `kvm_amd` for the CPU it finds, and `size = "auto"` sizes it.
4. Point the fleet at the new versions with `aws ec2 modify-fleet`: the
   same `--launch-template-configs` it has, overrides included, with each
   template's new version. The fleet names a version of each template by
   number (`aws ec2 describe-fleets` shows them), so a new default version
   alone changes nothing it launches.
5. Check it before relying on it: a replacement that boots without the
   runner leaves CI down until someone looks. `systemctl is-enabled iwci`
   on a host booted from it says `enabled`, never `masked`.
6. Delete an old image only after `describe-fleets` shows no version that
   names it. On 2026-11-25 the image with the empty unit files was deleted
   while the fleet still named the template versions made for it; the host
   it had launched kept running until AWS took it back on 2026-11-26 at
   10:46 UTC, every replacement then failed with `InvalidAMIID.NotFound`,
   and CI was down until someone looked: the fleet stays `active` and
   `pending_fulfillment`, and the reason is only in
   `aws ec2 describe-fleet-history`.

A new instance has a new address: put it in the host's `ssh_host` before
`terraform apply`, and check its SSH host key against the fingerprints
cloud-init prints to the console (`aws ec2 get-console-output`). One that replaces a host this state already has is a new
machine, not a reprovision: `terraform state rm 'terraform_data.host["ci-2"]'`
first, or the destroy provisioner waits on the old address. Build the
machine image on the new host (see above) before it takes `platform: linux`
runs; until then it lists only `wasm`. Only one host may run with a
tunnel's token at a time, or the proxy's requests are shared between them.

## Not covered

TLS and reachability are yours: a tunnel token, or a TLS front that the
proxy can reach at `url`. The hosts need outbound HTTPS to R2 and to the git
hosts they clone from. Building `iwci` with `--features node` (for
`env:bash-node`) needs the bridge's V8 archive from the runner pool's bucket
(`ci-runner/builtins/v8/archive.sh fetch`); the release channel carries
builds for both x86_64 and arm64.

variable "hosts" {
  description = <<-EOT
    The machines that run `iwci serve`. Terraform connects to each over SSH
    to install it and, when the configuration changes, to restart it (which
    drains: running jobs finish first). Updates to iwci itself do not come
    from here: each server follows `update_channel` and replaces itself.

    - name: the runner's name, in run ids (lowercase, digits, `-`).
    - ssh_host / ssh_user / ssh_port: how Terraform reaches it; the user
      needs passwordless sudo.
    - url: how the proxy reaches it (https, through a tunnel or a TLS
      front). Leave `listen` on loopback when a tunnel carries the traffic.
    - cpus / memory: the runner's limits (default: the machine's).
    - memory_admission: what a job reserves of `memory`: `limit`, its own
      `memory:` (the default), or `estimate`, what it held the last times
      it ran, so that more jobs run at once. Set `zram` with `estimate`.
    - zram: the size of a compressed swap device in RAM, such as `12GiB`
      (about 4 GiB of RAM when full); none by default. The net under
      `memory_admission = "estimate"`: see files/install.sh.
    - iwci_binary_path: this host's first binary, when its architecture
      differs from `iwci_binary_path`'s (an ARM64 host beside x86_64 ones).
    - native_sandbox: prepare the host for native jobs (Bun) in gVisor
      sandboxes: the pinned gVisor release in /opt/iwci/lib, the system
      user `iwci-sandbox` the sandboxes run as, the root sandbox service
      that starts them (`sandbox_service_path`, checked against
      `sandbox_service_sha256`; socket-activated, only the runner may
      connect), and `Delegate=memory cpu pids` in the unit. Off by default;
      the runner's own flag for native jobs is separate.
    - sandbox_service_path: this host's sandbox service, when its
      architecture differs from the default's; `arch` (x86_64 by default)
      picks its pin from ci-runner/crates/iwci-sandbox-spawn/sha256, and
      sandbox_service_sha256 overrides that.
    - machines: prepare the host for `platform: linux` jobs, which run in
      a QEMU/KVM virtual machine per job: QEMU and erofs-utils, the
      runner's user in group `kvm`, and the
      runner pointed at /var/lib/iwci/machines. The images themselves are
      built on the host into that directory (ci-runner/images/README.md),
      not uploaded from here. It needs KVM: on x86_64 VT-x or AMD-V, on
      Graviton a `.metal` instance. The runner lists in /v1/capacity what it can run, and leaves out, with a
      line in its log, whatever the host lacks. Off by default.
    - tunnel_token: optional Cloudflare Tunnel token; when set, cloudflared
      is installed as a service and the tunnel's public hostname should
      point at http://<listen>.
  EOT
  type = list(object({
    name         = string
    ssh_host     = string
    ssh_user     = optional(string, "root")
    ssh_port     = optional(number, 22)
    url          = string
    listen       = optional(string, "127.0.0.1:8547")
    cpus         = optional(number)
    memory       = optional(string)
    tunnel_token = optional(string)
    # What a job reserves of `memory` (`limit` or `estimate`), and the
    # compressed swap in RAM that backs `estimate`.
    memory_admission = optional(string)
    zram             = optional(string)
    # This host's first binary, when its architecture differs from the
    # default's.
    iwci_binary_path = optional(string)
    # Native jobs in gVisor sandboxes (see above).
    native_sandbox         = optional(bool)
    sandbox_service_path   = optional(string)
    sandbox_service_sha256 = optional(string)
    # x86_64 or aarch64: which of the sandbox service's pinned builds this
    # host takes. x86_64 when unset.
    arch = optional(string)
    # Virtual machines for `platform: linux` jobs (see above).
    machines = optional(bool)
  }))
  default = []

  validation {
    condition     = alltrue([for h in var.hosts : can(regex("^[a-z0-9][a-z0-9-]{0,39}$", h.name))])
    error_message = "Runner names are lowercase letters, digits and `-`, up to 40, starting with a letter or digit."
  }
  validation {
    condition     = alltrue([for h in var.hosts : h.memory_admission == null || contains(["limit", "estimate"], coalesce(h.memory_admission, "limit"))])
    error_message = "memory_admission is `limit` or `estimate`."
  }
  validation {
    condition     = alltrue([for h in var.hosts : h.zram == null || can(regex("^[1-9][0-9]*(MiB|GiB)$", coalesce(h.zram, "1GiB")))])
    error_message = "zram is a size in MiB or GiB, such as `12GiB`."
  }
  validation {
    condition     = length(distinct([for h in var.hosts : h.name])) == length(var.hosts)
    error_message = "Each runner needs its own name."
  }
  validation {
    condition     = alltrue([for h in var.hosts : can(regex("^https?://[^/@]+/?$", h.url))])
    error_message = "url is an http(s) base URL with no path or credentials, such as https://ci-1.example.com."
  }
}

variable "ssh_private_key_path" {
  description = "The private key Terraform connects with (the agent is used when this is empty)."
  type        = string
  default     = ""
}

variable "iwci_binary_path" {
  description = "A local iwci binary for the hosts' platform, installed only on a host that has none yet. After that, hosts update themselves from update_channel."
  type        = string
}

variable "sandbox_service_path" {
  description = "A local build of the sandbox service (ci-runner/crates/iwci-sandbox-spawn/build.sh) for the hosts' platform, installed on every host with native_sandbox. Unused without one."
  type        = string
  default     = ""
}

variable "sandbox_service_sha256" {
  description = "Overrides the pin in ci-runner/crates/iwci-sandbox-spawn/sha256 for every host: the SHA-256 the sandbox service must have, checked here before upload and on the host before install. Empty uses the reviewed pin."
  type        = string
  default     = ""
}

variable "server_key" {
  description = "IWCI_SERVER_KEY for every runner: the bearer key the proxy sends (its RUNNER_KEY). At least 32 characters."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.server_key) >= 32
    error_message = "server_key must be at least 32 characters."
  }
}

variable "r2" {
  description = "The R2 bucket runners share (tools, caches, reports, usage, releases)."
  type = object({
    account_id        = string
    bucket            = string
    access_key_id     = string
    secret_access_key = string
  })
  sensitive = true
}

variable "update_channel" {
  description = "The release channel runners follow (`iwci release --channel`). Empty to never self-update."
  type        = string
  default     = "stable"
}

variable "release_public_key" {
  description = "IWCI_RELEASE_PUBLIC_KEY: releases must be signed by its pair (`iwci release-keygen`). Required when update_channel is set."
  type        = string
  default     = ""
}

variable "storage_quota" {
  description = "Each owner's cache storage unless a run says otherwise."
  type        = string
  default     = "100GiB"
}

variable "proxy_url" {
  description = "The CI proxy (app/packages/ci-proxy), told the runner list after the hosts are up. Empty to skip."
  type        = string
  default     = ""
}

variable "proxy_key" {
  description = "The proxy's PROXY_KEY, for PUT /v1/runners."
  type        = string
  default     = ""
  sensitive   = true
}

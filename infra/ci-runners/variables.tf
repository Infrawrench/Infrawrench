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
    - iwci_binary_path: this host's first binary, when its architecture
      differs from `iwci_binary_path`'s (an ARM64 host beside x86_64 ones).
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
    # This host's first binary, when its architecture differs from the
    # default's.
    iwci_binary_path = optional(string)
  }))
  default = []

  validation {
    condition     = alltrue([for h in var.hosts : can(regex("^[a-z0-9][a-z0-9-]{0,39}$", h.name))])
    error_message = "Runner names are lowercase letters, digits and `-`, up to 40, starting with a letter or digit."
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
  default     = "10GiB"
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

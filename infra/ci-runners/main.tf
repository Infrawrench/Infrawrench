# CI runner hosts, provisioned over SSH, and the proxy's list of them.
# README.md has the design; in short: Terraform installs and configures,
# the runners update themselves from a signed release channel, and every
# restart drains (running jobs finish) instead of killing.

locals {
  hosts = { for h in var.hosts : h.name => h }

  update_flags = var.update_channel == "" ? "" : "--update-channel ${var.update_channel}"

  # Each native host's sandbox service binary and its pinned SHA-256: its
  # own, or the default.
  service = { for name, h in local.hosts : name => (
    coalesce(h.native_sandbox, false) ? (h.sandbox_service_path != null && h.sandbox_service_path != "" ? h.sandbox_service_path : var.sandbox_service_path) : ""
  ) }
  # The pins are the ones reviewed in git, per architecture, beside the
  # service's build script (it checks a build against them); a host or the
  # whole set may name another.
  service_pins = { for line in split("\n", trimspace(file("${path.module}/../../ci-runner/crates/iwci-sandbox-spawn/sha256"))) :
    split(" ", line)[0] => split(" ", line)[1] if length(split(" ", line)) == 2
  }
  service_sha256 = { for name, h in local.hosts : name => (
    !coalesce(h.native_sandbox, false) ? "" :
    h.sandbox_service_sha256 != null && h.sandbox_service_sha256 != "" ? h.sandbox_service_sha256 :
    var.sandbox_service_sha256 != "" ? var.sandbox_service_sha256 :
    lookup(local.service_pins, coalesce(h.arch, "x86_64"), "")
  ) }

  # One env file per host. Quoted for systemd's EnvironmentFile.
  env = { for name, h in local.hosts : name => join("\n", compact([
    "IWCI_SERVER_KEY=\"${replace(replace(var.server_key, "\\", "\\\\"), "\"", "\\\"")}\"",
    "IWCI_R2_ACCOUNT_ID=\"${var.r2.account_id}\"",
    "IWCI_R2_BUCKET=\"${var.r2.bucket}\"",
    "IWCI_R2_ACCESS_KEY_ID=\"${var.r2.access_key_id}\"",
    "IWCI_R2_SECRET_ACCESS_KEY=\"${replace(replace(var.r2.secret_access_key, "\\", "\\\\"), "\"", "\\\"")}\"",
    var.release_public_key == "" ? "" : "IWCI_RELEASE_PUBLIC_KEY=\"${var.release_public_key}\"",
    h.cpus == null ? "" : "IWCI_CPUS=\"${h.cpus}\"",
    h.memory == null ? "" : "IWCI_MEMORY=\"${h.memory}\"",
    h.memory_admission == null ? "" : "IWCI_MEMORY_ADMISSION=\"${h.memory_admission}\"",
  ])) }

  unit = { for name, h in local.hosts : name => templatefile("${path.module}/files/iwci.service.tftpl", {
    listen         = h.listen
    storage_quota  = var.storage_quota
    update_flags   = local.update_flags
    native_sandbox = coalesce(h.native_sandbox, false)
    machines       = coalesce(h.machines, false)
  }) }
}

resource "terraform_data" "host" {
  for_each = local.hosts

  # Re-run when what is installed changes. Secrets are hashed so the state
  # only ever holds a digest of them.
  triggers_replace = sha256(join("\n", [
    local.env[each.key],
    local.unit[each.key],
    file("${path.module}/files/install.sh"),
    each.value.tunnel_token == null ? "" : sha256(each.value.tunnel_token),
    each.value.zram == null ? "" : each.value.zram,
    # A new sandbox service is installed where it is used.
    local.service_sha256[each.key],
    coalesce(each.value.native_sandbox, false) ? file("${path.module}/files/iwci-sandbox-spawn.socket") : "",
    coalesce(each.value.native_sandbox, false) ? file("${path.module}/files/iwci-sandbox-spawn@.service") : "",
  ]))

  lifecycle {
    precondition {
      condition     = !coalesce(each.value.native_sandbox, false) || (local.service[each.key] != "" && can(regex("^[0-9a-f]{64}$", local.service_sha256[each.key])))
      error_message = "A host with native_sandbox needs the sandbox service: sandbox_service_path (ci-runner/crates/iwci-sandbox-spawn/build.sh), and a pin for its architecture in ci-runner/crates/iwci-sandbox-spawn/sha256 (or sandbox_service_sha256)."
    }
    precondition {
      condition     = local.service[each.key] == "" || filesha256(local.service[each.key]) == local.service_sha256[each.key]
      error_message = "sandbox_service_path is not the build pinned for this host (ci-runner/crates/iwci-sandbox-spawn/sha256, or sandbox_service_sha256)."
    }
  }

  # How to reach the host. Read through `self` because the destroy
  # provisioner below may not read anything else.
  input = {
    host     = each.value.ssh_host
    user     = each.value.ssh_user
    port     = each.value.ssh_port
    key_path = var.ssh_private_key_path
  }

  connection {
    type        = "ssh"
    host        = self.input.host
    user        = self.input.user
    port        = self.input.port
    private_key = self.input.key_path == "" ? null : file(self.input.key_path)
    agent       = self.input.key_path == ""
  }

  provisioner "file" {
    source      = coalesce(each.value.iwci_binary_path, var.iwci_binary_path)
    destination = "/tmp/iwci.upload"
  }
  provisioner "file" {
    content     = local.env[each.key]
    destination = "/tmp/iwci.env"
  }
  provisioner "file" {
    content     = local.unit[each.key]
    destination = "/tmp/iwci.service"
  }
  provisioner "file" {
    content     = each.value.tunnel_token == null ? "" : each.value.tunnel_token
    destination = "/tmp/iwci-tunnel-token"
  }
  provisioner "file" {
    content     = each.value.zram == null ? "" : each.value.zram
    destination = "/tmp/iwci-zram"
  }
  provisioner "file" {
    content     = coalesce(each.value.native_sandbox, false) ? "true" : "false"
    destination = "/tmp/iwci-native"
  }
  provisioner "file" {
    content     = coalesce(each.value.machines, false) ? "true" : "false"
    destination = "/tmp/iwci-machines"
  }
  # The sandbox service and its pin, where native jobs are on (empty
  # elsewhere), and its units.
  provisioner "file" {
    source      = local.service[each.key] == "" ? "${path.module}/files/empty" : local.service[each.key]
    destination = "/tmp/iwci-sandbox-spawn.upload"
  }
  provisioner "file" {
    content     = local.service_sha256[each.key]
    destination = "/tmp/iwci-sandbox-spawn.sha256"
  }
  provisioner "file" {
    source      = "${path.module}/files/iwci-sandbox-spawn.socket"
    destination = "/tmp/iwci-sandbox-spawn.socket"
  }
  provisioner "file" {
    source      = "${path.module}/files/iwci-sandbox-spawn@.service"
    destination = "/tmp/iwci-sandbox-spawn@.service"
  }
  provisioner "file" {
    source      = "${path.module}/files/install.sh"
    destination = "/tmp/iwci-install.sh"
  }
  provisioner "remote-exec" {
    inline = ["sudo bash /tmp/iwci-install.sh"]
  }

  # Removing a host stops it gracefully first; the proxy already skips a
  # draining runner, and the list update below drops it.
  provisioner "remote-exec" {
    when       = destroy
    on_failure = continue
    inline     = ["sudo systemctl disable --now iwci || true"]
  }
}

resource "terraform_data" "proxy_runners" {
  count = var.proxy_url == "" ? 0 : 1

  triggers_replace = jsonencode([for h in var.hosts : { name = h.name, url = trimsuffix(h.url, "/") }])

  depends_on = [terraform_data.host]

  provisioner "local-exec" {
    # The key goes through the environment, not the command line, so it is
    # not in a process listing or Terraform's log.
    environment = {
      PROXY_KEY = var.proxy_key
      BODY      = jsonencode({ runners = [for h in var.hosts : { name = h.name, url = trimsuffix(h.url, "/") }] })
    }
    command = "curl -fsS -X PUT -H \"Authorization: Bearer $PROXY_KEY\" -H 'Content-Type: application/json' --data \"$BODY\" '${trimsuffix(var.proxy_url, "/")}/v1/runners'"
  }
}

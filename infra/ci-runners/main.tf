# CI runner hosts, provisioned over SSH, and the proxy's list of them.
# README.md has the design; in short: Terraform installs and configures,
# the runners update themselves from a signed release channel, and every
# restart drains (running jobs finish) instead of killing.

locals {
  hosts = { for h in var.hosts : h.name => h }

  update_flags = var.update_channel == "" ? "" : "--update-channel ${var.update_channel}"

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
  ])) }

  unit = { for name, h in local.hosts : name => templatefile("${path.module}/files/iwci.service.tftpl", {
    listen        = h.listen
    storage_quota = var.storage_quota
    update_flags  = local.update_flags
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
  ]))

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
    source      = var.iwci_binary_path
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

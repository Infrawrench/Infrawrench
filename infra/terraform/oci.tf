# The github-watcher on Oracle Cloud's Always Free tier, replacing the GKE
# `github-watcher` Deployment (the cluster itself stays: ClickHouse and the
# cloudflared connector run there). The session gateway is on AWS instead
# (aws-web.tf): Oracle's free Ampere capacity in us-ashburn-1 was exhausted in
# every availability domain for days.
#
# - One E2.1.Micro VM (1/8 OCPU, 1 GB, 2 GB swap) runs the watcher.
# - Nothing listens on a public port. SSH is open only to `oci_admin_cidrs`.
#
# The VM is configured by the shared deploy agent (infra/vm/agent.sh), run
# every minute, which reads the configuration, the registry login and itself
# from a private bucket through a read-only pre-authenticated request. Images
# come from Oracle's own registry (OCIR): after each deploy CI copies the new
# build there as `github-watcher:oci` and the agent rolls it out. Not Artifact
# Registry: the GCP org policy forbids service-account keys, and pulls inside
# Oracle cost no egress. infra/README.md ("Oracle Cloud") is the runbook.
#
# Terraform authenticates with the API key in ~/.oci/config.

variable "oci_enabled" {
  description = "Create the Oracle Cloud session gateway and github-watcher VMs."
  type        = bool
  default     = false
}

variable "oci_tenancy_ocid" {
  description = "Tenancy OCID (the `tenancy=` line of ~/.oci/config)."
  type        = string
  default     = ""
}

variable "oci_region" {
  description = "Home region of the tenancy; Always Free compute exists only there."
  type        = string
  default     = "us-ashburn-1"
}

variable "oci_user_ocid" {
  description = "OCID of the user whose API key terraform uses; it also owns the OCIR auth token."
  type        = string
  default     = ""
}

variable "oci_config_profile" {
  description = "Profile in ~/.oci/config that terraform signs requests with."
  type        = string
  default     = "DEFAULT"
}



variable "oci_ssh_public_key" {
  description = "Public key for the `ubuntu` user on the VMs (debugging only)."
  type        = string
  default     = ""
}

variable "oci_admin_cidrs" {
  description = "CIDRs allowed to SSH to the VMs. Empty closes SSH entirely."
  type        = list(string)
  default     = []
}


locals {
  oci_enabled     = var.oci_enabled
  oci_vcn_cidr    = "10.42.0.0/16"
  oci_subnet_cidr = "10.42.1.0/24"

  ocir_host = "${var.oci_region == "us-ashburn-1" ? "iad" : var.oci_region}.ocir.io"

  # Same configuration as the Lambda functions: app_env with lambda_app_env's
  # overrides (ClickHouse through the tunnel hostname, not the cluster DNS
  # name these VMs cannot resolve). Shell-quoted, with the key list on its own
  # line, because GITHUB_APP_PRIVATE_KEY is multi-line.
  oci_env = merge(var.app_env, var.lambda_app_env)
  oci_runtime_env = join("\n", concat(
    ["IW_ENV_KEYS='${join(" ", sort(keys(local.oci_env)))}'"],
    [for k in sort(keys(local.oci_env)) : "${k}='${replace(local.oci_env[k], "'", "'\\''")}'"],
    [""],
  ))
}

provider "oci" {
  region              = var.oci_region
  config_file_profile = var.oci_config_profile
}

# ---------------------------------------------------------------------------
# Compartment and network
# ---------------------------------------------------------------------------

resource "oci_identity_compartment" "infrawrench" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
  name           = "infrawrench"
  description    = "Infrawrench session gateway and github-watcher (infra/terraform/oci.tf)."
  enable_delete  = true
}

data "oci_identity_availability_domains" "ads" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
}

resource "oci_core_vcn" "infrawrench" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = oci_identity_compartment.infrawrench[0].id
  cidr_blocks    = [local.oci_vcn_cidr]
  display_name   = "infrawrench"
  dns_label      = "infrawrench"
}

resource "oci_core_internet_gateway" "infrawrench" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = oci_identity_compartment.infrawrench[0].id
  vcn_id         = oci_core_vcn.infrawrench[0].id
  display_name   = "infrawrench"
}

resource "oci_core_route_table" "infrawrench" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = oci_identity_compartment.infrawrench[0].id
  vcn_id         = oci_core_vcn.infrawrench[0].id
  display_name   = "infrawrench"
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.infrawrench[0].id
  }
}

# Outbound is open (registry, Cloudflare, Neon, provider APIs). Inbound: SSH
# from the admin CIDRs and path-MTU ICMP.
resource "oci_core_security_list" "infrawrench" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = oci_identity_compartment.infrawrench[0].id
  vcn_id         = oci_core_vcn.infrawrench[0].id
  display_name   = "infrawrench"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = var.oci_admin_cidrs
    content {
      source   = ingress_security_rules.value
      protocol = "6"
      tcp_options {
        min = 22
        max = 22
      }
    }
  }

  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "infrawrench" {
  count             = local.oci_enabled ? 1 : 0
  compartment_id    = oci_identity_compartment.infrawrench[0].id
  vcn_id            = oci_core_vcn.infrawrench[0].id
  cidr_block        = local.oci_subnet_cidr
  display_name      = "infrawrench"
  dns_label         = "apps"
  route_table_id    = oci_core_route_table.infrawrench[0].id
  security_list_ids = [oci_core_security_list.infrawrench[0].id]
}

# ---------------------------------------------------------------------------
# Runtime bucket: what the agents read
# ---------------------------------------------------------------------------

data "oci_objectstorage_namespace" "ns" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
}

resource "oci_objectstorage_bucket" "runtime" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = oci_identity_compartment.infrawrench[0].id
  namespace      = data.oci_objectstorage_namespace.ns[0].namespace
  name           = "infrawrench-runtime"
  access_type    = "NoPublicAccess"
}

# Read-only, object-level (no listing). The URL is the agents' only secret;
# rotate it by tainting this resource, which also means replacing the VMs.
resource "oci_objectstorage_preauthrequest" "runtime" {
  count     = local.oci_enabled ? 1 : 0
  namespace = data.oci_objectstorage_namespace.ns[0].namespace
  bucket    = oci_objectstorage_bucket.runtime[0].name
  name      = "infrawrench-agents"
  # Listing stays denied (the default; setting it explicitly is not read back
  # and would replace this, and with it the URL the VMs hold, on every apply).
  access_type  = "AnyObjectRead"
  time_expires = "2036-01-01T00:00:00Z"
}

locals {
  oci_par_url = local.oci_enabled ? oci_objectstorage_preauthrequest.runtime[0].full_path : ""
}

resource "oci_objectstorage_object" "agent" {
  count     = local.oci_enabled ? 1 : 0
  namespace = data.oci_objectstorage_namespace.ns[0].namespace
  bucket    = oci_objectstorage_bucket.runtime[0].name
  object    = "agent.sh"
  content   = file("${path.module}/../vm/agent.sh")
}

resource "oci_objectstorage_object" "runtime_env" {
  count     = local.oci_enabled ? 1 : 0
  namespace = data.oci_objectstorage_namespace.ns[0].namespace
  bucket    = oci_objectstorage_bucket.runtime[0].name
  object    = "runtime.env"
  content   = local.oci_runtime_env
}


# Pulling from OCIR. An auth token is the only credential OCIR's docker login
# takes (a user may hold two); CI pushes with the same one, from the
# OCIR_USERNAME / OCIR_TOKEN secrets of the `production` environment.
resource "oci_artifacts_container_repository" "app" {
  for_each       = local.oci_enabled ? toset(["github-watcher"]) : toset([])
  compartment_id = oci_identity_compartment.infrawrench[0].id
  display_name   = "infrawrench/${each.key}"
  is_public      = false
}

data "oci_identity_user" "terraform" {
  count   = local.oci_enabled ? 1 : 0
  user_id = var.oci_user_ocid
}

resource "oci_identity_auth_token" "ocir" {
  count       = local.oci_enabled ? 1 : 0
  user_id     = var.oci_user_ocid
  description = "OCIR pulls by the Infrawrench VMs and pushes by CI (infra/terraform/oci.tf)"
}

locals {
  ocir_namespace = local.oci_enabled ? data.oci_objectstorage_namespace.ns[0].namespace : ""
  ocir_repo      = "${local.ocir_host}/${local.ocir_namespace}/infrawrench"
  # Identity-domain users log in as <namespace>/<username>.
  ocir_username = local.oci_enabled ? "${local.ocir_namespace}/${data.oci_identity_user.terraform[0].name}" : ""
}

resource "oci_objectstorage_object" "registry_env" {
  count     = local.oci_enabled ? 1 : 0
  namespace = data.oci_objectstorage_namespace.ns[0].namespace
  bucket    = oci_objectstorage_bucket.runtime[0].name
  object    = "registry.env"
  content   = "REGISTRY_USER='${local.ocir_username}'\nREGISTRY_PASSWORD='${oci_identity_auth_token.ocir[0].token}'\n"
}

output "ocir" {
  description = "Values for CI: OCIR_REGISTRY (repository variable), OCIR_USERNAME and OCIR_TOKEN (production environment secrets)."
  value = local.oci_enabled ? {
    registry = local.ocir_repo
    username = local.ocir_username
  } : null
}

output "ocir_token" {
  description = "OCIR auth token (the OCIR_TOKEN secret): terraform output -raw ocir_token"
  value       = local.oci_enabled ? oci_identity_auth_token.ocir[0].token : ""
  sensitive   = true
}

# CI's own Oracle identity, for pruning OCIR: every deploy leaves the previous
# image untagged, and OCIR storage counts against the 20 GB Always Free object
# storage. Least privilege: one group, allowed only to manage the container
# repositories in this compartment.
resource "tls_private_key" "oci_ci" {
  count     = local.oci_enabled ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "oci_identity_user" "ci" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
  name           = "infrawrench-ci"
  description    = "GitHub Actions: prunes untagged OCIR images (infra/terraform/oci.tf)"
  email          = "infrawrench-ci@infrawrench.com"
}

resource "oci_identity_group" "ci" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
  name           = "infrawrench-ci"
  description    = "Infrawrench CI: manage container repositories in the infrawrench compartment"
}

resource "oci_identity_user_group_membership" "ci" {
  count    = local.oci_enabled ? 1 : 0
  user_id  = oci_identity_user.ci[0].id
  group_id = oci_identity_group.ci[0].id
}

resource "oci_identity_policy" "ci" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
  name           = "infrawrench-ci"
  description    = "Infrawrench CI prunes OCIR images (infra/terraform/oci.tf)"
  statements = [
    "Allow group 'Default'/'infrawrench-ci' to manage repos in compartment infrawrench",
  ]
}

resource "oci_identity_api_key" "ci" {
  count     = local.oci_enabled ? 1 : 0
  user_id   = oci_identity_user.ci[0].id
  key_value = tls_private_key.oci_ci[0].public_key_pem
}

output "oci_ci" {
  description = "Repo variables for CI's OCIR pruning: OCI_CI_USER, OCI_CI_FINGERPRINT, OCI_TENANCY, OCI_COMPARTMENT (the private key is `terraform output -raw oci_ci_private_key`, secret OCI_CI_KEY)."
  value = local.oci_enabled ? {
    user        = oci_identity_user.ci[0].id
    fingerprint = oci_identity_api_key.ci[0].fingerprint
    tenancy     = var.oci_tenancy_ocid
    compartment = oci_identity_compartment.infrawrench[0].id
  } : null
}

output "oci_ci_private_key" {
  value     = local.oci_enabled ? tls_private_key.oci_ci[0].private_key_pem : ""
  sensitive = true
}

# ---------------------------------------------------------------------------
# Instances
# ---------------------------------------------------------------------------


data "oci_core_images" "ubuntu_amd" {
  count                    = local.oci_enabled ? 1 : 0
  compartment_id           = var.oci_tenancy_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.E2.1.Micro"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# The Always Free micro shape is offered in one availability domain only
# (AD-2 in us-ashburn-1); find it rather than hard-coding it.
data "oci_limits_limit_values" "micro" {
  count          = local.oci_enabled ? 1 : 0
  compartment_id = var.oci_tenancy_ocid
  service_name   = "compute"
  name           = "vm-standard-e2-1-micro-count"
}

locals {
  oci_micro_ad = local.oci_enabled ? one([
    for v in data.oci_limits_limit_values.micro[0].limit_values : v.availability_domain if v.value > 0
  ]) : ""
}


resource "oci_core_instance" "watcher" {
  count = local.oci_enabled ? 1 : 0

  compartment_id      = oci_identity_compartment.infrawrench[0].id
  availability_domain = local.oci_micro_ad
  display_name        = "infrawrench-github-watcher"
  shape               = "VM.Standard.E2.1.Micro"

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu_amd[0].images[0].id
    boot_volume_size_in_gbs = 50
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.infrawrench[0].id
    assign_public_ip = true
    private_ip       = cidrhost(local.oci_subnet_cidr, 21)
    hostname_label   = "github-watcher"
  }

  metadata = {
    ssh_authorized_keys = var.oci_ssh_public_key
    user_data = base64encode(templatefile("${path.module}/../vm/cloud-init-oci.yaml", {
      role          = "watcher"
      par_url       = local.oci_par_url
      image         = "${local.ocir_repo}/github-watcher:oci"
      registry_host = local.ocir_host
      deploy_delay  = 0
      swap_gb       = 2
      vcn_cidr      = local.oci_vcn_cidr
    }))
  }

  lifecycle {
    ignore_changes = [source_details[0].source_id, metadata]
  }

  depends_on = [
    oci_objectstorage_object.agent,
    oci_objectstorage_object.runtime_env,
    oci_objectstorage_object.registry_env,
  ]
}

output "oci_instances" {
  description = "Oracle Cloud VMs: name => public IP (SSH as ubuntu from oci_admin_cidrs)."
  value       = local.oci_enabled ? { "github-watcher" = oci_core_instance.watcher[0].public_ip } : {}
}

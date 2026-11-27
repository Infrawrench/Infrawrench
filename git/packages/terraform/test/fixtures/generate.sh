#!/usr/bin/env bash
# Regenerates plan.json and state.tfstate beside this script with the real
# `terraform` binary. Everything is `terraform_data`, the resource built into
# Terraform itself, so nothing is downloaded and no provider is installed.
#
#   bash test/fixtures/generate.sh
#
# The outputs are committed: the summary and matcher tests read them, so they
# pass on a machine without Terraform.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

export TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1

cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.4"
}

variable "release" {
  type    = string
  default = "v1"
}

resource "terraform_data" "keep" {
  input = "stays the same"
}

resource "terraform_data" "bump" {
  input = var.release
}

resource "terraform_data" "replaced" {
  input            = "payload"
  triggers_replace = [var.release]
}

resource "terraform_data" "gone" {
  count = var.release == "v1" ? 1 : 0
  input = "removed in v2"
}

resource "terraform_data" "renamed_old" {
  input = "moves"
}

output "release" {
  value = terraform_data.bump.output
}

output "secret" {
  value     = "hunter2-${var.release}"
  sensitive = true
}
EOF

terraform init -input=false > /dev/null
terraform apply -input=false -auto-approve > /dev/null
cp terraform.tfstate "$out/state.tfstate"

sed 's/"renamed_old"/"renamed_new"/' main.tf > main.tf.next
mv main.tf.next main.tf
cat >> main.tf <<'EOF'

moved {
  from = terraform_data.renamed_old
  to   = terraform_data.renamed_new
}

resource "terraform_data" "added" {
  input = { size = 3, name = "new" }
}

output "added_id" {
  value = terraform_data.added.id
}
EOF

terraform plan -input=false -var release=v2 -out=tfplan > /dev/null
terraform show -json tfplan | python3 -m json.tool > "$out/plan.json"
terraform show -no-color tfplan > "$out/plan.txt"

# A plan with nothing to do.
terraform apply -input=false -auto-approve -var release=v2 > /dev/null
terraform plan -input=false -var release=v2 -out=tfplan > /dev/null
terraform show -json tfplan | python3 -m json.tool > "$out/plan-noop.json"

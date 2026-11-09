terraform {
  # `terraform_data` and its provisioners are built in: this root needs no
  # providers, only SSH to the hosts and HTTPS to the proxy.
  required_version = ">= 1.6"
}

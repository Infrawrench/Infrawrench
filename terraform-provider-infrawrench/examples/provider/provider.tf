terraform {
  required_providers {
    infrawrench = {
      source  = "Infrawrench/infrawrench"
      version = "~> 0.1"
    }
  }
}

# api_key comes from INFRAWRENCH_API_KEY, so the credential never reaches a
# .tf file or a saved plan. An Infrawrench API key (iwk_…) is the right
# credential for CI: long-lived, scoped, revocable, pinned to one organization.
provider "infrawrench" {
  organization_id = "org_01HXYZABCDEF"
}

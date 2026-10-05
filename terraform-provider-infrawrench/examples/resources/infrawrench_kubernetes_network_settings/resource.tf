# Split the cluster's real billed data transfer across its workloads, instead
# of showing list-price estimates. The query selects the billed rows: here the
# AWS account that owns the nodes and its data-transfer service.
resource "infrawrench_kubernetes_network_settings" "prod" {
  account_id   = infrawrench_account.prod_cluster.id
  billed_query = "account = '${infrawrench_account.prod_aws.id}' AND service = 'AWS Data Transfer'"
}

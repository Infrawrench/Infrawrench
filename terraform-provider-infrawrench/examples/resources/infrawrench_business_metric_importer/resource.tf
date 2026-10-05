resource "infrawrench_business_metric" "requests" {
  key  = "api-requests"
  name = "API requests"
  unit = "request"
  kind = "count"
}

# Daily request count from an Application Load Balancer's CloudWatch metric.
resource "infrawrench_business_metric_importer" "requests" {
  metric_id  = infrawrench_business_metric.requests.id
  account_id = "acc_0123456789"

  params = {
    region     = "us-east-1"
    namespace  = "AWS/ApplicationELB"
    metricName = "RequestCount"
    dimensions = "LoadBalancer=app/prod-api/50dc6c495c0c9188"
    stat       = "Sum"
  }

  schedule      = "daily"
  backfill_days = 7
  timezone      = "UTC"
  aggregation   = "sum"
}

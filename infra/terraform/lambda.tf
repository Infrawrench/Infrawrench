# The AWS Lambda gateway (see "Lambda gateway" in infra/README.md): the web
# app's stateless Node work and the gateway half of the poller, on Lambda
# behind the Cloudflare edge Worker, in place of most of what the GKE pods do.
#
#   Cloudflare Worker (edge) --> Lambda web gateway (function URL)
#                            \-> GKE web pods (session gateway: WebSockets,
#                                in-process registries, chat)
#   EventBridge Scheduler ----> Lambda poller (POLLER_SCOPE from app_env)
#
# Everything here is gated on `lambda_enabled`, so a deployment that has not
# adopted it creates nothing in AWS and needs no AWS credentials. The
# functions themselves additionally wait for `lambda_initial_image_tag`: a
# Lambda cannot be created before its image exists in ECR, and the image is
# pushed by CI (`.github/workflows/web-deploy.yml`, `deploy-lambda`). After
# that CI owns the code (`update-function-code`) and terraform owns the
# configuration, the same split as infra/k8s and this directory.
#
# Configuration is `app_env`, unchanged: it is far past Lambda's 4 KB
# environment limit, so it goes into one Secrets Manager secret that the
# functions read at cold start (`server-core/src/runtime/lambda.ts`), merged
# with `lambda_app_env` for the few values that must differ on Lambda.

variable "lambda_enabled" {
  description = "Create the AWS side of the Lambda gateway (ECR, IAM, secret, network, and once an image exists, the functions)."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = <<-EOT
    AWS region for the Lambda gateway. us-east-2 is where Neon `core` lives and
    where both edge Workers are pinned (`placement.region`), so every
    Postgres round trip stays in-region.
  EOT
  type        = string
  default     = "us-east-2"
}

variable "lambda_initial_image_tag" {
  description = <<-EOT
    Tag of an image already in the Lambda ECR repository (a commit SHA pushed
    by the deploy-lambda job). Empty skips the functions, which is how the
    first apply works: apply, let CI push an image, set this, apply again.
    Only read when a function is created; CI deploys every later image.
  EOT
  type        = string
  default     = ""
}

variable "lambda_app_env" {
  description = <<-EOT
    Overrides merged over app_env for the Lambda functions only. Typically:
    CLICKHOUSE_METRICS_URL (the Cloudflare Tunnel hostname, since the
    in-cluster Service name does not resolve from AWS),
    CLICKHOUSE_METRICS_HTTP_HEADERS (the Cloudflare Access service token), and
    DATABASE_URL pointed at Neon's pooled (`-pooler`) endpoint, since many
    short-lived environments each open their own connections. See
    terraform.tfvars.example.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "lambda_vpc_enabled" {
  description = <<-EOT
    Run the functions in a dedicated VPC whose outbound traffic leaves through
    one NAT gateway and Elastic IP (the `lambda_egress_ip` output), the AWS
    counterpart of the cluster's Cloud NAT address. Costs a NAT gateway. Off
    means AWS's shared Lambda address ranges, which no one can usefully
    allowlist.
  EOT
  type        = bool
  default     = true
}

variable "lambda_web_memory_mb" {
  description = "Memory for the web gateway function. CPU scales with it; 1769 MB is one vCPU, and the API's cold start is CPU-bound."
  type        = number
  default     = 2048
}

variable "lambda_poller_memory_mb" {
  description = "Memory for the poller function."
  type        = number
  default     = 2048
}

variable "lambda_poller_reserved_concurrency" {
  description = <<-EOT
    Most poller invocations that may run at once. Each runs for most of a
    minute and the schedule fires every minute, so two overlap briefly; the
    cap stops overrunning ticks piling up against Postgres. -1 removes it
    (needed on accounts whose concurrency quota is still the new-account 10,
    since reserving any leaves less than the required unreserved 100).
  EOT
  type        = number
  default     = 3
}

locals {
  lambda_enabled   = var.lambda_enabled
  lambda_functions = var.lambda_enabled && var.lambda_initial_image_tag != ""
  lambda_name      = "${var.cluster_name}-lambda"
}

provider "aws" {
  region = var.aws_region

  # Without the Lambda gateway nothing here references the provider, and these
  # keep `terraform plan` from demanding AWS credentials anyway.
  skip_credentials_validation = !var.lambda_enabled
  skip_requesting_account_id  = !var.lambda_enabled
  skip_metadata_api_check     = !var.lambda_enabled

  default_tags {
    tags = {
      app       = "infrawrench"
      component = "lambda-gateway"
    }
  }
}

# ---------------------------------------------------------------------------
# Shared secret between the edge Worker and the web function
# ---------------------------------------------------------------------------

# The function URL is public (a Worker cannot sign SigV4 without carrying AWS
# credentials), so the Worker proves itself with this. It reaches the Worker
# the way every other value does: through the `infrawrench-env` secret that
# deploy-edge uploads (kubernetes.tf merges it in), and the function through
# the Secrets Manager secret below.
resource "random_password" "lambda_gateway" {
  count   = local.lambda_enabled ? 1 : 0
  length  = 48
  special = false
}

locals {
  # Merged into `infrawrench-env` by kubernetes.tf, for the edge Worker.
  lambda_worker_env = local.lambda_enabled ? merge(
    { LAMBDA_GATEWAY_SECRET = random_password.lambda_gateway[0].result },
    local.lambda_functions ? { LAMBDA_GATEWAY_URL = trimsuffix(aws_lambda_function_url.web[0].function_url, "/") } : {},
  ) : {}
}

# ---------------------------------------------------------------------------
# Image repository
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "lambda" {
  count                = local.lambda_enabled ? 1 : 0
  name                 = local.lambda_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Same retention as Artifact Registry: the 30 most recent images. Rolling back
# further means rebuilding.
resource "aws_ecr_lifecycle_policy" "lambda" {
  count      = local.lambda_enabled ? 1 : 0
  repository = aws_ecr_repository.lambda[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 30 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "app_env" {
  count       = local.lambda_enabled ? 1 : 0
  name        = "${local.lambda_name}/app-env"
  description = "app_env for the Infrawrench Lambda functions (infra/terraform/lambda.tf)."
  # Recreating the stack should not wait out a deletion window on its own name.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app_env" {
  count     = local.lambda_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.app_env[0].id
  secret_string = jsonencode(merge(
    var.app_env,
    { LAMBDA_GATEWAY_SECRET = random_password.lambda_gateway[0].result },
    var.lambda_app_env,
  ))
}

# ---------------------------------------------------------------------------
# Network: a VPC whose only way out is one NAT gateway with a fixed address
# ---------------------------------------------------------------------------
#
# Nothing else lives in this VPC and it is peered with nothing, so the private
# ranges the egress guard refuses hold only the functions' own interfaces.

data "aws_availability_zones" "available" {
  count = local.lambda_enabled && var.lambda_vpc_enabled ? 1 : 0
  state = "available"
}

locals {
  lambda_vpc = local.lambda_enabled && var.lambda_vpc_enabled
  lambda_azs = local.lambda_vpc ? slice(data.aws_availability_zones.available[0].names, 0, 2) : []
}

resource "aws_vpc" "lambda" {
  count                = local.lambda_vpc ? 1 : 0
  cidr_block           = "10.100.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.lambda_name }
}

resource "aws_internet_gateway" "lambda" {
  count  = local.lambda_vpc ? 1 : 0
  vpc_id = aws_vpc.lambda[0].id
  tags   = { Name = local.lambda_name }
}

resource "aws_subnet" "lambda_public" {
  count             = local.lambda_vpc ? 1 : 0
  vpc_id            = aws_vpc.lambda[0].id
  cidr_block        = "10.100.0.0/24"
  availability_zone = local.lambda_azs[0]
  tags              = { Name = "${local.lambda_name}-public" }
}

# Two zones for the functions, so losing one zone does not stop them. The NAT
# gateway is in one zone only: a zonal outage would cut egress until it
# recovers, traded against a second gateway's cost.
resource "aws_subnet" "lambda_private" {
  count             = local.lambda_vpc ? 2 : 0
  vpc_id            = aws_vpc.lambda[0].id
  cidr_block        = "10.100.${16 + count.index * 16}.0/20"
  availability_zone = local.lambda_azs[count.index]
  tags              = { Name = "${local.lambda_name}-private-${count.index}" }
}

resource "aws_eip" "lambda_nat" {
  count  = local.lambda_vpc ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${local.lambda_name}-nat" }
}

resource "aws_nat_gateway" "lambda" {
  count         = local.lambda_vpc ? 1 : 0
  allocation_id = aws_eip.lambda_nat[0].id
  subnet_id     = aws_subnet.lambda_public[0].id
  tags          = { Name = local.lambda_name }

  depends_on = [aws_internet_gateway.lambda]
}

resource "aws_route_table" "lambda_public" {
  count  = local.lambda_vpc ? 1 : 0
  vpc_id = aws_vpc.lambda[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lambda[0].id
  }
  tags = { Name = "${local.lambda_name}-public" }
}

resource "aws_route_table_association" "lambda_public" {
  count          = local.lambda_vpc ? 1 : 0
  subnet_id      = aws_subnet.lambda_public[0].id
  route_table_id = aws_route_table.lambda_public[0].id
}

resource "aws_route_table" "lambda_private" {
  count  = local.lambda_vpc ? 1 : 0
  vpc_id = aws_vpc.lambda[0].id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.lambda[0].id
  }
  tags = { Name = "${local.lambda_name}-private" }
}

resource "aws_route_table_association" "lambda_private" {
  count          = local.lambda_vpc ? 2 : 0
  subnet_id      = aws_subnet.lambda_private[count.index].id
  route_table_id = aws_route_table.lambda_private[0].id
}

# Egress only. Nothing connects in to a function's interface; invocations
# arrive through the Lambda service, not the VPC.
resource "aws_security_group" "lambda" {
  count       = local.lambda_vpc ? 1 : 0
  name        = local.lambda_name
  description = "Infrawrench Lambda functions: outbound only"
  vpc_id      = aws_vpc.lambda[0].id

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ---------------------------------------------------------------------------
# Execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  count = local.lambda_enabled ? 1 : 0
  name  = local.lambda_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  count      = local.lambda_enabled ? 1 : 0
  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count      = local.lambda_vpc ? 1 : 0
  role       = aws_iam_role.lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# The role's only other permission. Its credentials sit in the process
# environment like any Lambda's; the workflow sandbox never sees
# `process.env`, and the role can read one secret the process already holds.
resource "aws_iam_role_policy" "lambda_app_env" {
  count = local.lambda_enabled ? 1 : 0
  name  = "read-app-env"
  role  = aws_iam_role.lambda[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.app_env[0].arn
    }]
  })
}

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambda_enabled ? toset(["web", "poller"]) : toset([])
  name              = "/aws/lambda/${local.lambda_name}-${each.key}"
  retention_in_days = 30
}

locals {
  lambda_image_uri = local.lambda_functions ? "${aws_ecr_repository.lambda[0].repository_url}:${var.lambda_initial_image_tag}" : ""
  lambda_environment = local.lambda_enabled ? {
    INFRAWRENCH_APP_ENV_SECRET_ARN = aws_secretsmanager_secret.app_env[0].arn
    # Read by nothing: it changes the functions' configuration whenever
    # app_env does, so running environments are replaced and the web
    # function publishes a version (and so a snapshot) holding the new values.
    INFRAWRENCH_APP_ENV_VERSION = aws_secretsmanager_secret_version.app_env[0].version_id
    NODE_OPTIONS                = "--enable-source-maps"
  } : {}
  # What the function URL serves; CI moves it to each version it publishes.
  lambda_web_alias = "live"
}

resource "aws_lambda_function" "web" {
  count         = local.lambda_functions ? 1 : 0
  function_name = "${local.lambda_name}-web"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  architectures = ["x86_64"]
  memory_size   = var.lambda_web_memory_mb
  # The ceiling for one request. Anything that can run longer (deploys,
  # chat) is routed to the session gateway instead.
  timeout = 900

  image_config {
    command = ["app/packages/web/dist/lambda.handler"]
  }

  # SnapStart: init (the whole API with every plugin, tens of seconds) runs
  # once when a version is published, and new environments resume from a
  # snapshot of it. Only published versions get one, so the function URL
  # serves the `live` alias below, and terraform publishes a version whenever
  # it changes the configuration (CI does on each deploy).
  publish = true
  snap_start {
    apply_on = "PublishedVersions"
  }

  # SnapStart's ceiling. Uploads big enough to need more go to the session
  # gateway (SESSION_ROUTES).
  ephemeral_storage {
    size = 512
  }

  environment {
    variables = local.lambda_environment
  }

  dynamic "vpc_config" {
    for_each = local.lambda_vpc ? [1] : []
    content {
      subnet_ids         = aws_subnet.lambda_private[*].id
      security_group_ids = [aws_security_group.lambda[0].id]
    }
  }

  # CI deploys the code; terraform keeps the configuration.
  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.lambda_logs]
}

# The provider reads `version` back as the newest published one, so this
# follows CI's deploys rather than undoing them, and moves to the version an
# apply publishes. A version takes a minute or two to snapshot; neither
# terraform nor CI points the alias at it before it is active.
resource "aws_lambda_alias" "web_live" {
  count            = local.lambda_functions ? 1 : 0
  name             = local.lambda_web_alias
  function_name    = aws_lambda_function.web[0].function_name
  function_version = aws_lambda_function.web[0].version
}

resource "aws_lambda_function_url" "web" {
  count              = local.lambda_functions ? 1 : 0
  function_name      = aws_lambda_function.web[0].function_name
  qualifier          = aws_lambda_alias.web_live[0].name
  authorization_type = "NONE"
  # Streamed responses: up to 200 MB instead of the buffered 6 MB.
  invoke_mode = "RESPONSE_STREAM"
}

# A function URL with auth NONE needs both statements (AWS, October 2025);
# `invoked_via_function_url` keeps the second from opening plain Invoke.
resource "aws_lambda_permission" "web_url" {
  count                  = local.lambda_functions ? 1 : 0
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.web[0].function_name
  qualifier              = aws_lambda_alias.web_live[0].name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "web_url_invoke" {
  count                    = local.lambda_functions ? 1 : 0
  statement_id             = "FunctionURLInvokeAllowPublicAccess"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.web[0].function_name
  qualifier                = aws_lambda_alias.web_live[0].name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_lambda_function" "poller" {
  count         = local.lambda_functions ? 1 : 0
  function_name = "${local.lambda_name}-poller"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  architectures = ["x86_64"]
  memory_size   = var.lambda_poller_memory_mb
  # Each invocation ticks for about 55s (poller/src/lambda.ts); the rest is
  # room for a slow last tick to finish rather than be cut off.
  timeout                        = 300
  reserved_concurrent_executions = var.lambda_poller_reserved_concurrency

  image_config {
    command = ["app/packages/poller/dist/lambda.handler"]
  }

  environment {
    variables = local.lambda_environment
  }

  dynamic "vpc_config" {
    for_each = local.lambda_vpc ? [1] : []
    content {
      subnet_ids         = aws_subnet.lambda_private[*].id
      security_group_ids = [aws_security_group.lambda[0].id]
    }
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy_attachment.lambda_logs]
}

# ---------------------------------------------------------------------------
# The poller's clock
# ---------------------------------------------------------------------------

resource "aws_iam_role" "poller_scheduler" {
  count = local.lambda_functions ? 1 : 0
  name  = "${local.lambda_name}-poller-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "poller_scheduler" {
  count = local.lambda_functions ? 1 : 0
  name  = "invoke-poller"
  role  = aws_iam_role.poller_scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.poller[0].arn
    }]
  })
}

resource "aws_scheduler_schedule" "poller" {
  count = local.lambda_functions ? 1 : 0
  name  = "${local.lambda_name}-poller"
  # The finest rate Scheduler offers; each invocation covers the minute with
  # the loop's own 15s ticks.
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.poller[0].arn
    role_arn = aws_iam_role.poller_scheduler[0].arn
    # A missed minute is covered by the next one; retrying would only stack
    # invocations.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ---------------------------------------------------------------------------
# CI: keyless, like the GCP side (ci.tf)
# ---------------------------------------------------------------------------

variable "aws_github_oidc_provider_arn" {
  description = <<-EOT
    ARN of an existing IAM OIDC provider for token.actions.githubusercontent.com.
    An AWS account can hold only one per URL, so set this if the account
    already has one; empty creates it.
  EOT
  type        = string
  default     = ""
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = local.lambda_enabled && var.aws_github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_provider_arn = var.aws_github_oidc_provider_arn != "" ? var.aws_github_oidc_provider_arn : one(aws_iam_openid_connect_provider.github[*].arn)
}

# Only jobs in this repository that run under the deploy environment can
# assume it: GitHub puts the environment in `sub` for such jobs, and the
# environment's deployment branch rule (main only) is what keeps other
# branches out, as on the GCP side.
resource "aws_iam_role" "lambda_ci" {
  count = local.lambda_enabled ? 1 : 0
  name  = "${local.lambda_name}-ci"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.github_deploy_environment}"
        }
      }
    }]
  })
}

# Push to the Lambda repository (and the session gateway's), swap code on the two functions, and publish the
# web function's versions: point its alias at a new one and delete old ones,
# which are billed for their snapshots while they exist. Nothing here can
# change a function's configuration, role or URL, or delete a function.
resource "aws_iam_role_policy" "lambda_ci" {
  count = local.lambda_enabled ? 1 : 0
  name  = "push-and-deploy"
  role  = aws_iam_role.lambda_ci[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        # The session gateway's repository too (aws-web.tf), when it exists.
        Resource = concat(
          [aws_ecr_repository.lambda[0].arn],
          [for repo in aws_ecr_repository.web : repo.arn],
        )
      },
      {
        Effect = "Allow"
        Action = [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionCode",
          "lambda:PublishVersion",
          "lambda:ListVersionsByFunction",
          "lambda:GetAlias",
          "lambda:UpdateAlias",
        ]
        Resource = "arn:aws:lambda:${var.aws_region}:*:function:${local.lambda_name}-*"
      },
      {
        # Qualified ARNs only: a numbered version, never the function itself.
        Effect   = "Allow"
        Action   = "lambda:DeleteFunction"
        Resource = "arn:aws:lambda:${var.aws_region}:*:function:${local.lambda_name}-web:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "lambda_ecr_repository" {
  description = "ECR repository the deploy-lambda job pushes to. Set as the LAMBDA_ECR_REPOSITORY repository variable in GitHub."
  value       = one(aws_ecr_repository.lambda[*].repository_url)
}

output "lambda_ci_role_arn" {
  description = "Role the deploy-lambda job assumes. Set as the AWS_LAMBDA_CI_ROLE_ARN repository variable in GitHub."
  value       = one(aws_iam_role.lambda_ci[*].arn)
}

output "lambda_web_function_url" {
  description = "The web gateway's function URL (the `live` alias). Already in infrawrench-env as LAMBDA_GATEWAY_URL; shown for smoke tests."
  value       = one(aws_lambda_function_url.web[*].function_url)
}

output "lambda_egress_ip" {
  description = "Elastic IP the Lambda functions' outbound traffic leaves from, the AWS counterpart of egress_ip."
  value       = one(aws_eip.lambda_nat[*].public_ip)
}

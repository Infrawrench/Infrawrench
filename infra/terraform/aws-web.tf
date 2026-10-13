# The session gateway on AWS: two t4g.medium instances (Graviton, 2 vCPU,
# 4 GiB) running the web image, replacing the GKE `web` Deployment (the
# cluster itself stays: ClickHouse and the cloudflared connector run there).
#
#   edge Worker --> Lambda (NODE_ROUTES) --> these instances (SESSION_ROUTES:
#   WebSockets, SSE, SSH and kubectl PTYs, uploads over 4 MiB)
#
# - One instance per availability zone, in the Lambda VPC's private subnets
#   (lambda.tf): no public address, nothing can connect in, and everything
#   they send leaves through the same NAT gateway and Elastic IP as the
#   functions (`lambda_egress_ip`), one address to allowlist for all of AWS.
# - Each runs the web image and a connector for one Cloudflare Tunnel.
#   `app.infrawrench.com` points at that tunnel; Cloudflare spreads requests
#   across every connected replica, and an instance that dies (or whose app
#   fails its health check, which makes the agent stop its connector) stops
#   receiving traffic. That is the failover; no load balancer is involved.
# - State one process holds (a bastion agent's connection, a shared console's
#   pty) is reached from the other instance through the realtime relay
#   (KNOWLEDGE.md, "Realtime relay"), so the tunnel's lack of affinity costs
#   nothing.
# - Admin access is Session Manager (`aws ssm start-session`): no SSH, no keys.
#
# The instances run the shared deploy agent (infra/vm/agent.sh) every minute.
# It reads the configuration from the functions' own app_env secret (the same
# values), the tunnel token and itself from a private bucket, and follows a
# moving tag in this file's ECR repository that CI's deploy-aws-web job sets
# after each deploy; web-2 rolls out three minutes after web-1.
# infra/README.md ("AWS session gateway") is the runbook.

variable "aws_web_enabled" {
  description = "Create the session gateway instances (needs lambda_enabled and lambda_vpc_enabled)."
  type        = bool
  default     = false
}

variable "aws_web_instance_type" {
  description = "Instance type for the session gateway. Graviton (arm64): the image CI builds for it."
  type        = string
  default     = "t4g.medium"
}

variable "session_gateway_tunnel_token" {
  description = <<-EOT
    Token of the Cloudflare Tunnel the session gateway connects to
    ("infrawrench-session-gateway", a different tunnel from
    cloudflare_tunnel_token, which is ClickHouse's). Its routes are
    app.infrawrench.com and session-gateway.infrawrench.com (a test hostname)
    to http://localhost:3000.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

locals {
  aws_web      = local.lambda_vpc && var.aws_web_enabled
  aws_web_name = "${var.cluster_name}-session"
  aws_web_nodes = {
    "web-1" = { subnet = 0, deploy_delay = 0 }
    "web-2" = { subnet = 1, deploy_delay = 180 }
  }
}

# ---------------------------------------------------------------------------
# Image and runtime files
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "web" {
  count = local.aws_web ? 1 : 0
  name  = local.aws_web_name
  # Mutable: the agents follow one moving tag (`session-arm64`).
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  count      = local.aws_web ? 1 : 0
  repository = aws_ecr_repository.web[0].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_s3_bucket" "session_runtime" {
  count         = local.aws_web ? 1 : 0
  bucket_prefix = "${local.aws_web_name}-runtime-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "session_runtime" {
  count                   = local.aws_web ? 1 : 0
  bucket                  = aws_s3_bucket.session_runtime[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "session_agent" {
  count  = local.aws_web ? 1 : 0
  bucket = aws_s3_bucket.session_runtime[0].id
  key    = "agent.sh"
  source = "${path.module}/../vm/agent.sh"
  etag   = filemd5("${path.module}/../vm/agent.sh")
}

resource "aws_s3_object" "session_tunnel_env" {
  count   = local.aws_web ? 1 : 0
  bucket  = aws_s3_bucket.session_runtime[0].id
  key     = "tunnel.env"
  content = "TUNNEL_TOKEN=${var.session_gateway_tunnel_token}\n"
}

# ---------------------------------------------------------------------------
# Instance role: pull the one image, read the configuration, Session Manager
# ---------------------------------------------------------------------------

resource "aws_iam_role" "session" {
  count = local.aws_web ? 1 : 0
  name  = local.aws_web_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "session" {
  count = local.aws_web ? 1 : 0
  name  = "pull-and-configure"
  role  = aws_iam_role.session[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.web[0].arn
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.app_env[0].arn
      },
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.session_runtime[0].arn}/*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "session_ssm" {
  count      = local.aws_web ? 1 : 0
  role       = aws_iam_role.session[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "session" {
  count = local.aws_web ? 1 : 0
  name  = local.aws_web_name
  role  = aws_iam_role.session[0].name
}

# ---------------------------------------------------------------------------
# Network: outbound only, plus the relay port between the two instances
# ---------------------------------------------------------------------------

resource "aws_security_group" "session" {
  count       = local.aws_web ? 1 : 0
  name        = local.aws_web_name
  description = "Infrawrench session gateway: outbound, and the cross-replica relay between the instances"
  vpc_id      = aws_vpc.lambda[0].id

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  # web/src/services/replica-relay.ts: Linux app sessions leased to one
  # instance are reached from the other at its private address.
  ingress {
    from_port = 3000
    to_port   = 3000
    protocol  = "tcp"
    self      = true
  }
}

# ---------------------------------------------------------------------------
# Instances
# ---------------------------------------------------------------------------

data "aws_ssm_parameter" "al2023_arm64" {
  count = local.aws_web ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "session" {
  for_each = local.aws_web ? local.aws_web_nodes : {}

  ami                    = data.aws_ssm_parameter.al2023_arm64[0].insecure_value
  instance_type          = var.aws_web_instance_type
  subnet_id              = aws_subnet.lambda_private[each.value.subnet].id
  vpc_security_group_ids = [aws_security_group.session[0].id]
  iam_instance_profile   = aws_iam_instance_profile.session[0].name

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  user_data = templatefile("${path.module}/../vm/cloud-init-aws.yaml", {
    aws_region     = var.aws_region
    app_env_secret = aws_secretsmanager_secret.app_env[0].arn
    runtime_bucket = aws_s3_bucket.session_runtime[0].id
    image          = "${aws_ecr_repository.web[0].repository_url}:session-arm64"
    registry_host  = split("/", aws_ecr_repository.web[0].repository_url)[0]
    deploy_delay   = each.value.deploy_delay
  })

  tags = { Name = "${local.aws_web_name}-${each.key}" }

  # The agent applies configuration and image changes in place; a newer AMI
  # or an edited bootstrap is not worth replacing a serving instance over.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  depends_on = [
    aws_s3_object.session_agent,
    aws_s3_object.session_tunnel_env,
    aws_iam_role_policy.session,
  ]
}

output "aws_web_instances" {
  description = "Session gateway instances: name => instance id (aws ssm start-session --target <id>)."
  value       = { for k, v in aws_instance.session : k => v.id }
}

output "aws_web_ecr_repository" {
  description = "ECR repository the session gateway pulls from (the AWS_WEB_ECR_REPOSITORY repo variable)."
  value       = local.aws_web ? aws_ecr_repository.web[0].repository_url : ""
}

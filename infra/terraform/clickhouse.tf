# Self-hosted ClickHouse for the metrics/costs store, replacing ClickHouse
# Cloud. One shard, two replicas (ReplicatedMergeTree via a Replicated
# database), coordinated by a three-node ClickHouse Keeper quorum. The
# replicas run on their own tainted node pool so they never fight the app
# pods for memory; Keeper is tiny and rides the default pool.
#
# Cutover is deliberate, not automatic: this file provisions the cluster and
# an `infrawrench` database/user, but the app keeps talking to whatever
# CLICKHOUSE_METRICS_URL is in tfvars until you point it here — see the
# ClickHouse block in terraform.tfvars.example for the cutover steps.

locals {
  ch_namespace    = kubernetes_namespace.infrawrench.metadata[0].name
  ch_database     = "infrawrench"
  ch_user         = "infrawrench"
  ch_replicas     = 2
  keeper_replicas = 3

  # Full LTS patch tag on purpose — a floating minor tag would silently change
  # the server version on any pod restart. Bump deliberately.
  ch_image     = "clickhouse/clickhouse-server:26.3.17.110"
  keeper_image = "clickhouse/clickhouse-keeper:26.3.17.110"

  ch_headless     = "clickhouse-headless"
  keeper_headless = "clickhouse-keeper-headless"

  ch_fqdns = [
    for i in range(local.ch_replicas) :
    "clickhouse-${i}.${local.ch_headless}.${local.ch_namespace}.svc.cluster.local"
  ]
  keeper_fqdns = [
    for i in range(local.keeper_replicas) :
    "clickhouse-keeper-${i}.${local.keeper_headless}.${local.ch_namespace}.svc.cluster.local"
  ]
}

# ---------------------------------------------------------------------------
# Node pool
# ---------------------------------------------------------------------------

data "google_compute_zones" "region" {
  region = var.region
}

# Exactly one node in each of two zones: a fixed home per replica, zone
# redundancy, and no autoscaler surprises under a stateful workload. The
# taint keeps app pods off; the ClickHouse pods tolerate it and select the
# role label.
resource "google_container_node_pool" "clickhouse" {
  name           = "clickhouse"
  cluster        = google_container_cluster.prod.id
  location       = var.region
  node_locations = slice(data.google_compute_zones.region.names, 0, local.ch_replicas)
  node_count     = 1

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type    = var.clickhouse_machine_type
    disk_size_gb    = 50
    disk_type       = "pd-balanced"
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      role = "clickhouse"
    }

    taint {
      key    = "dedicated"
      value  = "clickhouse"
      effect = "NO_SCHEDULE"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

resource "random_password" "clickhouse_app" {
  length  = 32
  special = false
}

resource "kubernetes_secret" "clickhouse_auth" {
  metadata {
    name      = "clickhouse-auth"
    namespace = local.ch_namespace
  }
  type = "Opaque"

  data = {
    CLICKHOUSE_APP_PASSWORD = random_password.clickhouse_app.result
  }
}

# ---------------------------------------------------------------------------
# ClickHouse Keeper (replication coordination)
# ---------------------------------------------------------------------------

resource "kubernetes_config_map" "clickhouse_keeper" {
  metadata {
    name      = "clickhouse-keeper-config"
    namespace = local.ch_namespace
  }

  data = {
    # server_id comes from the pod ordinal at runtime (see the container
    # command) — everything else is identical across the three pods.
    "keeper_config.xml" = <<-XML
      <clickhouse>
        <logger>
          <level>information</level>
          <console>1</console>
        </logger>
        <listen_host>0.0.0.0</listen_host>
        <keeper_server>
          <tcp_port>9181</tcp_port>
          <server_id from_env="SERVER_ID"/>
          <log_storage_path>/var/lib/clickhouse-keeper/coordination/log</log_storage_path>
          <snapshot_storage_path>/var/lib/clickhouse-keeper/coordination/snapshots</snapshot_storage_path>
          <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
            <raft_logs_level>warning</raft_logs_level>
          </coordination_settings>
          <raft_configuration>
            ${join("\n            ", [
    for i, fqdn in local.keeper_fqdns :
    "<server><id>${i + 1}</id><hostname>${fqdn}</hostname><port>9234</port></server>"
])}
          </raft_configuration>
        </keeper_server>
      </clickhouse>
    XML
}
}

resource "kubernetes_service" "clickhouse_keeper_headless" {
  metadata {
    name      = local.keeper_headless
    namespace = local.ch_namespace
  }
  spec {
    cluster_ip = "None"
    selector = {
      app = "clickhouse-keeper"
    }
    # Raft members must find each other before they are Ready.
    publish_not_ready_addresses = true
    port {
      name = "client"
      port = 9181
    }
    port {
      name = "raft"
      port = 9234
    }
  }
}

resource "kubernetes_stateful_set" "clickhouse_keeper" {
  metadata {
    name      = "clickhouse-keeper"
    namespace = local.ch_namespace
  }

  spec {
    service_name          = local.keeper_headless
    replicas              = local.keeper_replicas
    pod_management_policy = "Parallel" # all three must start for a quorum

    selector {
      match_labels = {
        app = "clickhouse-keeper"
      }
    }

    template {
      metadata {
        labels = {
          app = "clickhouse-keeper"
        }
        annotations = {
          # Restart the pods when the config changes — a ConfigMap update
          # alone does not.
          "infrawrench.com/config-hash" = sha256(kubernetes_config_map.clickhouse_keeper.data["keeper_config.xml"])
        }
      }

      spec {
        security_context {
          fs_group = 101 # the images run as uid 101 (clickhouse)
        }

        affinity {
          pod_anti_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 100
              pod_affinity_term {
                topology_key = "kubernetes.io/hostname"
                label_selector {
                  match_labels = {
                    app = "clickhouse-keeper"
                  }
                }
              }
            }
          }
        }

        container {
          name  = "keeper"
          image = local.keeper_image

          # Raft server ids are 1-based; derive them from the pod ordinal.
          command = [
            "/bin/sh",
            "-c",
            "h=\"$(hostname)\"; export SERVER_ID=\"$(( $${h##*-} + 1 ))\"; exec /usr/bin/clickhouse-keeper --config-file=/etc/clickhouse-keeper/keeper_config.xml",
          ]

          port {
            name           = "client"
            container_port = 9181
          }
          port {
            name           = "raft"
            container_port = 9234
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              memory = "1Gi"
            }
          }

          readiness_probe {
            tcp_socket {
              port = 9181
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }

          liveness_probe {
            tcp_socket {
              port = 9181
            }
            initial_delay_seconds = 30
            period_seconds        = 20
          }

          volume_mount {
            name       = "config"
            mount_path = "/etc/clickhouse-keeper"
          }
          volume_mount {
            name       = "data"
            mount_path = "/var/lib/clickhouse-keeper"
          }
        }

        volume {
          name = "config"
          config_map {
            name = kubernetes_config_map.clickhouse_keeper.metadata[0].name
          }
        }
      }
    }

    volume_claim_template {
      metadata {
        name = "data"
      }
      spec {
        access_modes       = ["ReadWriteOnce"]
        storage_class_name = "standard-rwo"
        resources {
          requests = {
            storage = "5Gi"
          }
        }
      }
    }
  }
}

resource "kubernetes_pod_disruption_budget_v1" "clickhouse_keeper" {
  metadata {
    name      = "clickhouse-keeper"
    namespace = local.ch_namespace
  }
  spec {
    max_unavailable = "1" # a 3-node quorum survives one missing member
    selector {
      match_labels = {
        app = "clickhouse-keeper"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# ClickHouse server
# ---------------------------------------------------------------------------

resource "kubernetes_config_map" "clickhouse_server" {
  metadata {
    name      = "clickhouse-server-config"
    namespace = local.ch_namespace
  }

  data = {
    # Mounted over /etc/clickhouse-server/config.d, which replaces the
    # image's docker_related_config.xml — hence the explicit listen_host.
    "cluster.xml" = <<-XML
      <clickhouse>
        <listen_host>0.0.0.0</listen_host>
        <!-- Replicas fetch merged parts from each other over this address;
             the default (hostname) is not resolvable across pods. -->
        <interserver_http_host from_env="MY_POD_FQDN"/>
        <macros>
          <shard>01</shard>
          <replica from_env="POD_NAME"/>
        </macros>
        <zookeeper>
          ${join("\n          ", [
    for fqdn in local.keeper_fqdns :
    "<node><host>${fqdn}</host><port>9181</port></node>"
    ])}
        </zookeeper>
        <remote_servers>
          <infrawrench>
            <shard>
              <internal_replication>true</internal_replication>
              ${join("\n              ", [
    for fqdn in local.ch_fqdns :
    "<replica><host>${fqdn}</host><port>9000</port></replica>"
])}
            </shard>
          </infrawrench>
        </remote_servers>
        <distributed_ddl>
          <path>/clickhouse/task_queue/ddl</path>
        </distributed_ddl>
      </clickhouse>
    XML

# Mounted over /etc/clickhouse-server/users.d. The app user's password is
# injected from the clickhouse-auth secret at runtime, so this stays a
# ConfigMap; the default user is restricted to localhost (it ships with no
# password and the server listens on 0.0.0.0).
"users.xml" = <<-XML
      <clickhouse>
        <users>
          <default>
            <networks replace="replace">
              <ip>127.0.0.1</ip>
              <ip>::1</ip>
            </networks>
          </default>
          <${local.ch_user}>
            <password from_env="CLICKHOUSE_APP_PASSWORD"/>
            <profile>default</profile>
            <quota>default</quota>
            <networks>
              <ip>::/0</ip>
            </networks>
          </${local.ch_user}>
        </users>
      </clickhouse>
    XML
}
}

resource "kubernetes_service" "clickhouse_headless" {
  metadata {
    name      = local.ch_headless
    namespace = local.ch_namespace
  }
  spec {
    cluster_ip = "None"
    selector = {
      app = "clickhouse"
    }
    # Replicas must resolve each other during startup replication recovery.
    publish_not_ready_addresses = true
    port {
      name = "http"
      port = 8123
    }
    port {
      name = "native"
      port = 9000
    }
    port {
      name = "interserver"
      port = 9009
    }
  }
}

# What the app connects to: CLICKHOUSE_METRICS_URL =
# http://clickhouse.infrawrench.svc.cluster.local:8123
resource "kubernetes_service" "clickhouse" {
  metadata {
    name      = "clickhouse"
    namespace = local.ch_namespace
  }
  spec {
    selector = {
      app = "clickhouse"
    }
    port {
      name = "http"
      port = 8123
    }
    port {
      name = "native"
      port = 9000
    }
  }
}

resource "kubernetes_stateful_set" "clickhouse" {
  metadata {
    name      = "clickhouse"
    namespace = local.ch_namespace
  }

  spec {
    service_name          = local.ch_headless
    replicas              = local.ch_replicas
    pod_management_policy = "Parallel"

    selector {
      match_labels = {
        app = "clickhouse"
      }
    }

    template {
      metadata {
        labels = {
          app = "clickhouse"
        }
        annotations = {
          "infrawrench.com/config-hash" = sha256(join("", values(kubernetes_config_map.clickhouse_server.data)))
        }
      }

      spec {
        security_context {
          fs_group = 101
        }

        node_selector = {
          role = "clickhouse"
        }

        toleration {
          key      = "dedicated"
          operator = "Equal"
          value    = "clickhouse"
          effect   = "NoSchedule"
        }

        # One replica per node — losing a node must only lose one replica.
        affinity {
          pod_anti_affinity {
            required_during_scheduling_ignored_during_execution {
              topology_key = "kubernetes.io/hostname"
              label_selector {
                match_labels = {
                  app = "clickhouse"
                }
              }
            }
          }
        }

        container {
          name  = "clickhouse"
          image = local.ch_image

          env {
            name = "POD_NAME"
            value_from {
              field_ref {
                field_path = "metadata.name"
              }
            }
          }
          env {
            name  = "MY_POD_FQDN"
            value = "$(POD_NAME).${local.ch_headless}.${local.ch_namespace}.svc.cluster.local"
          }
          env {
            name = "CLICKHOUSE_APP_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.clickhouse_auth.metadata[0].name
                key  = "CLICKHOUSE_APP_PASSWORD"
              }
            }
          }

          port {
            name           = "http"
            container_port = 8123
          }
          port {
            name           = "native"
            container_port = 9000
          }
          port {
            name           = "interserver"
            container_port = 9009
          }

          # Sized against an e2-standard-4 (~13.5Gi allocatable) that the pod
          # has to itself. No CPU limit on purpose: merges are bursty and the
          # node is dedicated.
          resources {
            requests = {
              cpu    = "2"
              memory = "10Gi"
            }
            limits = {
              memory = "12Gi"
            }
          }

          # First boot can spend a while on Keeper connection + part loading;
          # the startup probe absorbs that so liveness can stay tight.
          startup_probe {
            http_get {
              path = "/ping"
              port = 8123
            }
            period_seconds    = 10
            failure_threshold = 60
          }

          readiness_probe {
            http_get {
              path = "/ping"
              port = 8123
            }
            period_seconds = 10
          }

          liveness_probe {
            http_get {
              path = "/ping"
              port = 8123
            }
            period_seconds    = 20
            failure_threshold = 3
          }

          volume_mount {
            name       = "server-config"
            mount_path = "/etc/clickhouse-server/config.d"
          }
          volume_mount {
            name       = "users-config"
            mount_path = "/etc/clickhouse-server/users.d"
          }
          volume_mount {
            name       = "data"
            mount_path = "/var/lib/clickhouse"
          }
        }

        volume {
          name = "server-config"
          config_map {
            name = kubernetes_config_map.clickhouse_server.metadata[0].name
            items {
              key  = "cluster.xml"
              path = "cluster.xml"
            }
          }
        }
        volume {
          name = "users-config"
          config_map {
            name = kubernetes_config_map.clickhouse_server.metadata[0].name
            items {
              key  = "users.xml"
              path = "users.xml"
            }
          }
        }
      }
    }

    volume_claim_template {
      metadata {
        name = "data"
      }
      spec {
        access_modes       = ["ReadWriteOnce"]
        storage_class_name = "standard-rwo"
        resources {
          requests = {
            storage = "${var.clickhouse_disk_gb}Gi"
          }
        }
      }
    }
  }

  depends_on = [
    google_container_node_pool.clickhouse,
    kubernetes_stateful_set.clickhouse_keeper,
  ]
}

resource "kubernetes_pod_disruption_budget_v1" "clickhouse" {
  metadata {
    name      = "clickhouse"
    namespace = local.ch_namespace
  }
  spec {
    max_unavailable = "1"
    selector {
      match_labels = {
        app = "clickhouse"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Database bootstrap
# ---------------------------------------------------------------------------

# Creates the app database on both replicas (ON CLUSTER) with the Replicated
# database engine, so DDL from server-core's migrate.ts propagates between
# replicas without ON CLUSTER in the app. A Job rather than the image's
# /docker-entrypoint-initdb.d: init scripts run once against an empty data
# dir and fail permanently if Keeper isn't up yet — this retries until the
# cluster is actually ready.
resource "kubernetes_job" "clickhouse_bootstrap" {
  metadata {
    name      = "clickhouse-bootstrap"
    namespace = local.ch_namespace
  }

  spec {
    backoff_limit = 6

    template {
      metadata {
        labels = {
          app = "clickhouse-bootstrap"
        }
      }

      spec {
        restart_policy = "OnFailure"

        container {
          name  = "bootstrap"
          image = local.ch_image

          env {
            name = "CLICKHOUSE_APP_PASSWORD"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.clickhouse_auth.metadata[0].name
                key  = "CLICKHOUSE_APP_PASSWORD"
              }
            }
          }

          command = [
            "/bin/sh",
            "-c",
            <<-EOT
              for i in $(seq 1 120); do
                clickhouse-client --host clickhouse --user ${local.ch_user} \
                  --password "$CLICKHOUSE_APP_PASSWORD" \
                  --query "CREATE DATABASE IF NOT EXISTS ${local.ch_database} ON CLUSTER infrawrench ENGINE = Replicated('/clickhouse/databases/${local.ch_database}', '{shard}', '{replica}')" \
                  && exit 0
                echo "clickhouse not ready yet ($i), retrying"
                sleep 5
              done
              exit 1
            EOT
          ]
        }
      }
    }
  }

  wait_for_completion = false

  depends_on = [kubernetes_stateful_set.clickhouse]
}

# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------
# Replication covers a lost node or zone; these cover a bad DROP. A nightly
# CronJob runs ClickHouse's native `BACKUP DATABASE ... TO S3(...)` against
# the GCS bucket's S3-compatible XML endpoint (storage.googleapis.com), which
# is why auth is an HMAC key rather than Workload Identity — the backup is
# executed server-side by ClickHouse itself, whose S3 client doesn't speak
# GCP's metadata server. Retention is the bucket's lifecycle rule, not
# ClickHouse: the server only ever writes (each run under a fresh
# timestamped prefix — reusing one fails with BACKUP_ALREADY_EXISTS), so
# GCS's missing S3 batch-delete never comes into play.

resource "google_service_account" "clickhouse_backup" {
  account_id   = "${var.cluster_name}-ch-backup"
  display_name = "ClickHouse backups — HMAC key owner, write access to the backup bucket"
}

resource "google_storage_bucket" "clickhouse_backups" {
  name     = "${var.project_id}-clickhouse-backups"
  location = var.region

  # Nearline: backups are written once and read only during a restore, and
  # the 30-day lifecycle delete matches Nearline's 30-day minimum charge.
  storage_class               = "NEARLINE"
  uniform_bucket_level_access = true

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 30
    }
  }
}

resource "google_storage_bucket_iam_member" "clickhouse_backup" {
  bucket = google_storage_bucket.clickhouse_backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.clickhouse_backup.email}"
}

resource "google_storage_hmac_key" "clickhouse_backup" {
  service_account_email = google_service_account.clickhouse_backup.email
}

resource "kubernetes_secret" "clickhouse_backup_hmac" {
  metadata {
    name      = "clickhouse-backup-hmac"
    namespace = local.ch_namespace
  }
  type = "Opaque"

  data = {
    GCS_HMAC_ACCESS_ID = google_storage_hmac_key.clickhouse_backup.access_id
    GCS_HMAC_SECRET    = google_storage_hmac_key.clickhouse_backup.secret
  }
}

resource "kubernetes_cron_job_v1" "clickhouse_backup" {
  metadata {
    name      = "clickhouse-backup"
    namespace = local.ch_namespace
  }

  spec {
    # Nightly, an hour before the Sunday 04:00 UTC node maintenance window.
    schedule                      = "0 3 * * *"
    concurrency_policy            = "Forbid"
    successful_jobs_history_limit = 3
    failed_jobs_history_limit     = 3

    job_template {
      metadata {
        labels = {
          app = "clickhouse-backup"
        }
      }

      spec {
        backoff_limit              = 2
        active_deadline_seconds    = 5400
        ttl_seconds_after_finished = 259200 # 3 days

        template {
          metadata {
            labels = {
              app = "clickhouse-backup"
            }
          }

          spec {
            restart_policy = "Never"

            container {
              name  = "backup"
              image = local.ch_image

              env {
                name = "CLICKHOUSE_APP_PASSWORD"
                value_from {
                  secret_key_ref {
                    name = kubernetes_secret.clickhouse_auth.metadata[0].name
                    key  = "CLICKHOUSE_APP_PASSWORD"
                  }
                }
              }
              env {
                name = "GCS_HMAC_ACCESS_ID"
                value_from {
                  secret_key_ref {
                    name = kubernetes_secret.clickhouse_backup_hmac.metadata[0].name
                    key  = "GCS_HMAC_ACCESS_ID"
                  }
                }
              }
              env {
                name = "GCS_HMAC_SECRET"
                value_from {
                  secret_key_ref {
                    name = kubernetes_secret.clickhouse_backup_hmac.metadata[0].name
                    key  = "GCS_HMAC_SECRET"
                  }
                }
              }

              resources {
                requests = {
                  cpu    = "50m"
                  memory = "128Mi"
                }
              }

              # The BACKUP statement runs inside the server (this pod only
              # holds the connection open), so the client timeouts are the
              # knob that matters for a long-running backup.
              command = [
                "/bin/sh",
                "-c",
                <<-EOT
                  ts="$(date -u +%Y-%m-%dT%H-%M-%S)"
                  clickhouse-client --host clickhouse --user ${local.ch_user} \
                    --password "$CLICKHOUSE_APP_PASSWORD" \
                    --send_timeout 5400 --receive_timeout 5400 \
                    --query "BACKUP DATABASE ${local.ch_database} TO S3('https://storage.googleapis.com/${google_storage_bucket.clickhouse_backups.name}/full/$ts/', '$GCS_HMAC_ACCESS_ID', '$GCS_HMAC_SECRET')"
                EOT
              ]
            }
          }
        }
      }
    }
  }
}

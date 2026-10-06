/**
 * GraphQL documents. Field names checked against the live schema
 * (introspection of backboard.railway.com/graphql/v2, 2026-10) and against
 * the queries the official `railwayapp/cli` sends.
 */

export const Q_TOKEN_WORKSPACES = `query { apiToken { workspaces { id name } } }`;

export const Q_WORKSPACE = `query Workspace($id: String!) {
  workspace(workspaceId: $id) {
    id name plan has2FAEnforcement preferredRegion createdAt
    members { id name email role twoFactorAuthEnabled }
  }
}`;

export const Q_WORKSPACE_BILLING = `query WorkspaceBilling($id: String!) {
  workspace(workspaceId: $id) {
    id
    customer {
      id creditBalance currentUsage
      billingPeriod { start end }
      usageLimit { softLimit hardLimit isOverLimit }
    }
  }
}`;

export const Q_ESTIMATED_USAGE = `query Estimated($workspaceId: String!, $measurements: [MetricMeasurement!]!) {
  estimatedUsage(workspaceId: $workspaceId, measurements: $measurements, includeDeleted: true) {
    measurement estimatedValue
  }
}`;

export const Q_PROJECTS = `query Projects($workspaceId: String, $after: String) {
  projects(workspaceId: $workspaceId, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name } }
  }
}`;

const SERVICE_INSTANCE_FIELDS = `
  id serviceId serviceName environmentId region numReplicas
  startCommand buildCommand builder dockerfilePath rootDirectory railwayConfigFile
  healthcheckPath healthcheckTimeout cronSchedule nextCronRunAt sleepApplication
  restartPolicyType restartPolicyMaxRetries preDeployCommand createdAt updatedAt
  source { repo image }
  domains {
    serviceDomains { id domain suffix targetPort syncStatus createdAt }
    customDomains {
      id domain targetPort syncStatus createdAt
      status {
        verified certificateStatus certificateErrorMessage
        certificates { expiresAt }
        dnsRecords { hostlabel fqdn recordType requiredValue currentValue status }
      }
    }
  }
  latestDeployment { id status createdAt url staticUrl canRedeploy canRollback deploymentStopped meta }
`;

/** One project with every environment's service and volume instances. */
export const Q_PROJECT_TREE = `query ProjectTree($id: String!) {
  project(id: $id) {
    id name description isPublic prDeploys workspaceId createdAt updatedAt
    services(first: 200) { edges { node { id name icon createdAt } } }
    environments(first: 50) {
      edges { node {
        id name isEphemeral createdAt updatedAt
        serviceInstances(first: 200) { edges { node { ${SERVICE_INSTANCE_FIELDS} } } }
        volumeInstances(first: 200) { edges { node {
          id volumeId serviceId environmentId mountPath sizeMB currentSizeMB state region
          createdAt isPendingDeletion volume { id name }
        } } }
      } }
    }
  }
}`;

export const Q_DEPLOYMENTS = `query Deployments($input: DeploymentListInput!, $first: Int) {
  deployments(input: $input, first: $first) {
    edges { node {
      id status createdAt updatedAt url staticUrl canRedeploy canRollback deploymentStopped meta
      serviceId environmentId projectId
    } }
  }
}`;

export const Q_DEPLOYMENT = `query Deployment($id: String!) {
  deployment(id: $id) {
    id status createdAt updatedAt url staticUrl canRedeploy canRollback deploymentStopped meta
    serviceId environmentId projectId
  }
}`;

export const Q_VARIABLES = `query Variables($projectId: String!, $environmentId: String!, $serviceId: String) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
}`;

export const Q_TCP_PROXIES = `query TcpProxies($environmentId: String!, $serviceId: String!) {
  tcpProxies(environmentId: $environmentId, serviceId: $serviceId) {
    id domain proxyPort applicationPort serviceId environmentId syncStatus createdAt
  }
}`;

export const Q_REGIONS = `query Regions($projectId: String) {
  regions(projectId: $projectId) {
    name region country location
    deploymentConstraints { deprecationInfo { isDeprecated } }
  }
}`;

export const Q_LIMITS = `query Limits($environmentId: String!, $serviceId: String!) {
  serviceInstanceLimits(environmentId: $environmentId, serviceId: $serviceId)
}`;

export const Q_VOLUME_BACKUPS = `query Backups($id: String!) {
  volumeInstanceBackupList(volumeInstanceId: $id) {
    id name createdAt expiresAt usedMB referencedMB
  }
  volumeInstanceBackupScheduleList(volumeInstanceId: $id) { id kind name cron retentionSeconds }
}`;

export const Q_METRICS = `query Metrics(
  $environmentId: String, $serviceId: String, $volumeId: String,
  $startDate: DateTime!, $endDate: DateTime, $measurements: [MetricMeasurement!]!, $sampleRateSeconds: Int
) {
  metrics(
    environmentId: $environmentId, serviceId: $serviceId, volumeId: $volumeId,
    startDate: $startDate, endDate: $endDate, measurements: $measurements,
    sampleRateSeconds: $sampleRateSeconds
  ) { measurement values { ts value } }
}`;

export const Q_HTTP_METRICS = `query Http(
  $environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!, $stepSeconds: Int
) {
  httpMetrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, stepSeconds: $stepSeconds) {
    samples { ts value }
  }
  httpDurationMetrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, stepSeconds: $stepSeconds) {
    samples { ts p50 p95 p99 }
  }
}`;

export const Q_USAGE = `query Usage(
  $workspaceId: String!, $measurements: [MetricMeasurement!]!, $startDate: DateTime!, $endDate: DateTime!
) {
  usage(
    workspaceId: $workspaceId, measurements: $measurements,
    groupBy: [PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID],
    startDate: $startDate, endDate: $endDate, includeDeleted: true
  ) { measurement value tags { projectId environmentId serviceId } }
}`;

export const Q_DEPLOYMENT_LOGS = `query DeployLogs($id: String!, $limit: Int) {
  deploymentLogs(deploymentId: $id, limit: $limit) { timestamp message severity }
}`;

export const Q_BUILD_LOGS = `query BuildLogs($id: String!, $limit: Int) {
  buildLogs(deploymentId: $id, limit: $limit) { timestamp message severity }
}`;

export const Q_HTTP_LOGS = `query HttpLogs($id: String!, $limit: Int) {
  httpLogs(deploymentId: $id, limit: $limit) {
    timestamp method path httpStatus totalDuration host srcIp edgeRegion
  }
}`;

// ── Mutations ─────────────────────────────────────────────────────────

export const M = {
  projectCreate: `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`,
  projectUpdate: `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { id } }`,
  projectDelete: `mutation($id: String!) { projectDelete(id: $id) }`,
  environmentCreate: `mutation($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }`,
  environmentRename: `mutation($id: String!, $input: EnvironmentRenameInput!) { environmentRename(id: $id, input: $input) { id } }`,
  environmentDelete: `mutation($id: String!) { environmentDelete(id: $id) }`,
  serviceCreate: `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
  serviceUpdate: `mutation($id: String!, $input: ServiceUpdateInput!) { serviceUpdate(id: $id, input: $input) { id } }`,
  serviceDelete: `mutation($id: String!, $environmentId: String) { serviceDelete(id: $id, environmentId: $environmentId) }`,
  serviceInstanceUpdate: `mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
  }`,
  serviceInstanceLimitsUpdate: `mutation($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
  serviceInstanceDeploy: `mutation($serviceId: String!, $environmentId: String!, $commitSha: String, $latestCommit: Boolean) {
    serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha, latestCommit: $latestCommit)
  }`,
  serviceInstanceRedeploy: `mutation($serviceId: String!, $environmentId: String!) {
    serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
  }`,
  deploymentRedeploy: `mutation($id: String!) { deploymentRedeploy(id: $id) { id } }`,
  deploymentRollback: `mutation($id: String!) { deploymentRollback(id: $id) }`,
  deploymentRestart: `mutation($id: String!) { deploymentRestart(id: $id) }`,
  deploymentStop: `mutation($id: String!) { deploymentStop(id: $id) }`,
  deploymentCancel: `mutation($id: String!) { deploymentCancel(id: $id) }`,
  deploymentRemove: `mutation($id: String!) { deploymentRemove(id: $id) }`,
  deploymentApprove: `mutation($id: String!) { deploymentApprove(id: $id) }`,
  variableUpsert: `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
  variableDelete: `mutation($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
  volumeCreate: `mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
  volumeUpdate: `mutation($volumeId: String!, $input: VolumeUpdateInput!) { volumeUpdate(volumeId: $volumeId, input: $input) { id } }`,
  volumeInstanceUpdate: `mutation($volumeId: String!, $environmentId: String, $input: VolumeInstanceUpdateInput!) {
    volumeInstanceUpdate(volumeId: $volumeId, environmentId: $environmentId, input: $input)
  }`,
  volumeDelete: `mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`,
  backupCreate: `mutation($id: String!, $name: String) { volumeInstanceBackupCreate(volumeInstanceId: $id, name: $name) { workflowId } }`,
  backupRestore: `mutation($id: String!, $backupId: String!) {
    volumeInstanceBackupRestore(volumeInstanceId: $id, volumeInstanceBackupId: $backupId) { workflowId }
  }`,
  backupSchedule: `mutation($id: String!, $kinds: [VolumeInstanceBackupScheduleKind!]!) {
    volumeInstanceBackupScheduleUpdate(volumeInstanceId: $id, kinds: $kinds)
  }`,
  serviceDomainCreate: `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }`,
  serviceDomainUpdate: `mutation($input: ServiceDomainUpdateInput!) { serviceDomainUpdate(input: $input) }`,
  serviceDomainDelete: `mutation($id: String!) { serviceDomainDelete(id: $id) }`,
  customDomainCreate: `mutation($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain } }`,
  customDomainUpdate: `mutation($id: String!, $environmentId: String!, $targetPort: Int) {
    customDomainUpdate(id: $id, environmentId: $environmentId, targetPort: $targetPort)
  }`,
  customDomainDelete: `mutation($id: String!) { customDomainDelete(id: $id) }`,
  customDomainIssueCertificate: `mutation($id: String!) { customDomainIssueCertificate(id: $id) }`,
  tcpProxyCreate: `mutation($input: TCPProxyCreateInput!) { tcpProxyCreate(input: $input) { id domain proxyPort } }`,
  tcpProxyDelete: `mutation($id: String!) { tcpProxyDelete(id: $id) }`,
  usageLimitSet: `mutation($input: UsageLimitSetInput!) { usageLimitSet(input: $input) }`,
  usageLimitRemove: `mutation($input: UsageLimitRemoveInput!) { usageLimitRemove(input: $input) }`,
};

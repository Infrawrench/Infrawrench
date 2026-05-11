import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { signRequest } from "./auth.js";
import {
  ec2Call,
  ec2QueryCall,
  hostForService,
  jsonCall,
  jsonGetCall,
  queryPostCall,
} from "./client-transport.js";

export interface DeleteContext {
  creds: AwsCredentials;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

export async function deleteResource(
  ctx: DeleteContext,
  typeId: string,
  resourceId: string,
  accountId: string,
): Promise<void> {
  const { creds } = ctx;
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const externalId = resource.externalId ?? "";

  switch (typeId) {
    case "ec2-instance":
      await ec2Call(creds, "TerminateInstances", { "InstanceId.1": externalId });
      break;
    case "ebs-volume":
      await ec2Call(creds, "DeleteVolume", { VolumeId: externalId });
      break;
    case "vpc":
      await ec2Call(creds, "DeleteVpc", { VpcId: externalId });
      break;
    case "subnet":
      await ec2Call(creds, "DeleteSubnet", { SubnetId: externalId });
      break;
    case "security-group":
      await ec2Call(creds, "DeleteSecurityGroup", { GroupId: externalId });
      break;
    case "nat-gateway":
      await ec2Call(creds, "DeleteNatGateway", { NatGatewayId: externalId });
      break;
    case "elastic-ip":
      await ec2Call(creds, "ReleaseAddress", { AllocationId: externalId });
      break;
    case "s3-bucket":
      await jsonCall(creds, "s3", "AmazonS3.DeleteBucket", { Bucket: externalId });
      break;
    case "lambda-function":
      await jsonGetCall(creds, "lambda", `/2015-03-31/functions/${encodeURIComponent(externalId)}`);
      // Lambda uses DELETE method — need a separate helper
      {
        const host = hostForService(creds, "lambda");
        const url = `https://${host}/2015-03-31/functions/${encodeURIComponent(externalId)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "lambda",
          credentials: creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`Lambda delete ${externalId} failed: ${res.status}`);
      }
      break;
    case "sqs-queue": {
      const queueUrl = String(resource.fields["queueUrl"] ?? "");
      await jsonCall(creds, "sqs", "AmazonSQS.DeleteQueue", { QueueUrl: queueUrl });
      break;
    }
    case "sns-topic": {
      const topicArn = String(resource.fields["topicArn"] ?? "");
      await jsonCall(creds, "sns", "SNS.DeleteTopic", { TopicArn: topicArn });
      break;
    }
    case "dynamodb-table":
      await jsonCall(creds, "dynamodb", "DynamoDB_20120810.DeleteTable", { TableName: externalId });
      break;
    case "secrets-manager-secret":
      await jsonCall(creds, "secretsmanager", "secretsmanager.DeleteSecret", {
        SecretId: externalId,
        ForceDeleteWithoutRecovery: true,
      });
      break;
    case "ecr-repository":
      await jsonCall(creds, "ecr", "AmazonEC2ContainerRegistry_V20150921.DeleteRepository", {
        repositoryName: externalId,
        force: true,
      });
      break;
    case "cloudformation-stack":
      await jsonCall(creds, "cloudformation", "CloudFormation.DeleteStack", {
        StackName: externalId,
      });
      break;
    case "ssm-parameter":
      await jsonCall(creds, "ssm", "AmazonSSM.DeleteParameter", { Name: externalId });
      break;
    case "cloudwatch-alarm":
      await jsonCall(creds, "monitoring", "GraniteServiceVersion20100801.DeleteAlarms", {
        AlarmNames: [externalId],
      });
      break;
    case "cloudwatch-log-group":
      await jsonCall(creds, "logs", "Logs_20140328.DeleteLogGroup", {
        logGroupName: externalId,
      });
      break;
    case "internet-gateway":
      await ec2Call(creds, "DeleteInternetGateway", { InternetGatewayId: externalId });
      break;
    case "cloudtrail-trail":
      await jsonCall(
        creds,
        "cloudtrail",
        "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.DeleteTrail",
        {
          Name: externalId,
        },
      );
      break;
    case "sagemaker-endpoint": {
      const host = hostForService(creds, "sagemaker");
      const url = `https://${host}`;
      const headers = await signRequest({
        method: "POST",
        url,
        headers: {
          Host: host,
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "SageMaker.DeleteEndpoint",
        },
        body: JSON.stringify({ EndpointName: externalId }),
        service: "sagemaker",
        credentials: creds,
      });
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ EndpointName: externalId }),
      });
      if (!res.ok) throw new Error(`SageMaker delete endpoint ${externalId} failed: ${res.status}`);
      break;
    }
    case "ecs-service": {
      // externalId is "clusterName/serviceName"
      const [cluster, service] = externalId.split("/");
      // Force delete the service (stops tasks automatically)
      await jsonCall(creds, "ecs", "AmazonEC2ContainerServiceV20141113.DeleteService", {
        cluster: cluster ?? "",
        service: service ?? "",
        force: true,
      });
      break;
    }
    case "elasticache-cluster":
      await queryPostCall(creds, "elasticache", "DeleteCacheCluster", "2015-02-02", {
        CacheClusterId: externalId,
      });
      break;
    case "rds-instance":
      await queryPostCall(creds, "rds", "DeleteDBInstance", "2014-10-31", {
        DBInstanceIdentifier: externalId,
        SkipFinalSnapshot: "true",
        DeleteAutomatedBackups: "true",
      });
      break;
    case "rds-cluster":
      await queryPostCall(creds, "rds", "DeleteDBCluster", "2014-10-31", {
        DBClusterIdentifier: externalId,
        SkipFinalSnapshot: "true",
      });
      break;
    case "redshift-cluster":
      await ec2QueryCall(creds, "redshift", "DeleteCluster", "2012-12-01", {
        ClusterIdentifier: externalId,
        SkipFinalClusterSnapshot: "true",
      });
      break;
    case "opensearch-domain": {
      const host = hostForService(creds, "es");
      const path = `/2021-01-01/opensearch/domain/${encodeURIComponent(externalId)}`;
      const url = `https://${host}${path}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "es",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`OpenSearch delete ${externalId} failed: ${res.status}`);
      break;
    }
    case "route53-hosted-zone": {
      const host = hostForService(creds, "route53");
      const url = `https://${host}/2013-04-01/hostedzone/${externalId}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "route53",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok)
        throw new Error(`Route53 delete hosted zone ${externalId} failed: ${res.status}`);
      break;
    }
    case "route53-record-set": {
      // externalId is "zoneId:name:type"
      const [zoneId, recordName, recordType] = externalId.split(":");
      const ttl = Number(resource.fields["ttl"] ?? 300);
      const values = String(resource.fields["values"] ?? "");
      const resourceRecords = values
        .split(", ")
        .filter(Boolean)
        .map((v) => `<ResourceRecord><Value>${v}</Value></ResourceRecord>`)
        .join("");
      const xmlBody = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">',
        "<ChangeBatch><Changes><Change>",
        "<Action>DELETE</Action>",
        "<ResourceRecordSet>",
        `<Name>${recordName}</Name>`,
        `<Type>${recordType}</Type>`,
        `<TTL>${ttl}</TTL>`,
        `<ResourceRecords>${resourceRecords}</ResourceRecords>`,
        "</ResourceRecordSet>",
        "</Change></Changes></ChangeBatch>",
        "</ChangeResourceRecordSetsRequest>",
      ].join("");
      const host = hostForService(creds, "route53");
      const url = `https://${host}/2013-04-01/hostedzone/${zoneId}/rrset`;
      const headers = await signRequest({
        method: "POST",
        url,
        headers: { Host: host, "Content-Type": "application/xml" },
        body: xmlBody,
        service: "route53",
        credentials: creds,
      });
      const res = await fetch(url, { method: "POST", headers, body: xmlBody });
      if (!res.ok) throw new Error(`Route53 delete record set ${externalId} failed: ${res.status}`);
      break;
    }
    case "alb": {
      const albArn = String(resource.resolvedOutputs["loadBalancerArn"] ?? "");
      await ec2QueryCall(creds, "elasticloadbalancing", "DeleteLoadBalancer", "2015-12-01", {
        LoadBalancerArn: albArn,
      });
      break;
    }
    case "target-group": {
      const tgArn = String(resource.resolvedOutputs["targetGroupArn"] ?? "");
      await ec2QueryCall(creds, "elasticloadbalancing", "DeleteTargetGroup", "2015-12-01", {
        TargetGroupArn: tgArn,
      });
      break;
    }
    case "auto-scaling-group":
      await ec2QueryCall(creds, "autoscaling", "DeleteAutoScalingGroup", "2011-01-01", {
        AutoScalingGroupName: externalId,
        ForceDelete: "true",
      });
      break;
    case "step-function": {
      const smArn = String(resource.resolvedOutputs["stateMachineArn"] ?? "");
      await jsonCall(creds, "states", "AWSStepFunctions.DeleteStateMachine", {
        stateMachineArn: smArn,
      });
      break;
    }
    case "eventbridge-rule":
      await jsonCall(creds, "events", "AWSEvents.DeleteRule", {
        Name: externalId,
        Force: true,
      });
      break;
    case "kinesis-stream":
      await jsonCall(creds, "kinesis", "Kinesis_20131202.DeleteStream", {
        StreamName: externalId,
        EnforceConsumerDeletion: true,
      });
      break;
    case "efs-file-system": {
      const host = hostForService(creds, "elasticfilesystem");
      const url = `https://${host}/2015-02-01/file-systems/${encodeURIComponent(externalId)}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "elasticfilesystem",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`EFS delete ${externalId} failed: ${res.status}`);
      break;
    }
    case "api-gateway": {
      const host = hostForService(creds, "apigateway");
      const url = `https://${host}/v2/apis/${encodeURIComponent(externalId)}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "apigateway",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`API Gateway delete ${externalId} failed: ${res.status}`);
      break;
    }
    case "apprunner-service": {
      const serviceArn = String(resource.resolvedOutputs["serviceArn"] ?? "");
      await jsonCall(creds, "apprunner", "AppRunner.DeleteService", {
        ServiceArn: serviceArn,
      });
      break;
    }
    case "codebuild-project":
      await jsonCall(creds, "codebuild", "CodeBuild_20161006.DeleteProject", {
        name: externalId,
      });
      break;
    case "codepipeline-pipeline":
      await jsonCall(creds, "codepipeline", "CodePipeline_20150709.DeletePipeline", {
        name: externalId,
      });
      break;
    case "batch-job-queue":
      // Disable the job queue first, then delete
      await jsonCall(creds, "batch", "AWSBatch.UpdateJobQueue", {
        jobQueue: externalId,
        state: "DISABLED",
      });
      await jsonCall(creds, "batch", "AWSBatch.DeleteJobQueue", {
        jobQueue: externalId,
      });
      break;
    case "msk-cluster": {
      const clusterArn = String(resource.resolvedOutputs["clusterArn"] ?? "");
      const host = hostForService(creds, "kafka");
      const url = `https://${host}/v1/clusters/${encodeURIComponent(clusterArn)}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "kafka",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`MSK delete cluster ${externalId} failed: ${res.status}`);
      break;
    }
    case "neptune-cluster":
      // Route through Neptune's own endpoint (fixed in this migration);
      // the action name matches RDS's because Neptune shares the API
      // surface, but it must hit neptune.<region>.amazonaws.com.
      await queryPostCall(creds, "neptune", "DeleteDBCluster", "2014-10-31", {
        DBClusterIdentifier: externalId,
        SkipFinalSnapshot: "true",
      });
      break;
    case "documentdb-cluster":
      await queryPostCall(creds, "rds", "DeleteDBCluster", "2014-10-31", {
        DBClusterIdentifier: externalId,
        SkipFinalSnapshot: "true",
      });
      break;
    case "mq-broker": {
      const host = hostForService(creds, "mq");
      const url = `https://${host}/v1/brokers/${encodeURIComponent(externalId)}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "mq",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`MQ delete broker ${externalId} failed: ${res.status}`);
      break;
    }
    case "glue-database":
      await jsonCall(creds, "glue", "AWSGlue.DeleteDatabase", {
        Name: externalId,
      });
      break;
    case "iam-user":
      await queryPostCall(creds, "iam", "DeleteUser", "2010-05-08", {
        UserName: externalId,
      });
      break;
    case "iam-role":
      await queryPostCall(creds, "iam", "DeleteRole", "2010-05-08", {
        RoleName: externalId,
      });
      break;
    case "acm-certificate":
      await jsonCall(creds, "acm", "CertificateManager.DeleteCertificate", {
        CertificateArn: externalId,
      });
      break;
    case "waf-web-acl": {
      const webAclId = String(resource.resolvedOutputs["webAclId"] ?? "");
      // First get the WebACL to retrieve the LockToken
      const wafDetail = await jsonCall<{
        WebACL: Record<string, unknown>;
        LockToken: string;
      }>(creds, "wafv2", "AWSWAF_20190729.GetWebACL", {
        Name: externalId,
        Scope: "REGIONAL",
        Id: webAclId,
      });
      await jsonCall(creds, "wafv2", "AWSWAF_20190729.DeleteWebACL", {
        Name: externalId,
        Scope: "REGIONAL",
        Id: webAclId,
        LockToken: wafDetail.LockToken,
      });
      break;
    }
    case "eks-cluster": {
      const host = hostForService(creds, "eks");
      const url = `https://${host}/clusters/${encodeURIComponent(externalId)}`;
      const headers = await signRequest({
        method: "DELETE",
        url,
        headers: { Host: host },
        service: "eks",
        credentials: creds,
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok) throw new Error(`EKS delete cluster ${externalId} failed: ${res.status}`);
      break;
    }
    default:
      throw new Error(`AWS plugin: deleteResource not supported for type "${typeId}"`);
  }
}

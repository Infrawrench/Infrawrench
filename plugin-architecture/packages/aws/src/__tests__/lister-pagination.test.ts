/**
 * Every AWS lister must follow its continuation token to the last page.
 *
 * Each case feeds the lister two pages in the shape the AWS API reference
 * documents (XML bodies go through the real `parseXml`, exactly as the
 * transport does), then asserts that the second request carried the first
 * page's token and that items from both pages came back. Page one holds two
 * items and page two one, so the single-item XML case (which parses to a bare
 * object rather than an array) is covered as well.
 */
import { describe, it, expect, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ListerContext } from "../resource-listers.js";
import {
  listEC2Instances,
  listEBSVolumes,
  listVPCs,
  listEKSClusters,
  listRDSInstances,
  listS3Buckets,
  listECSServices,
  listDynamoDBTables,
  listElastiCacheClusters,
  listSQSQueues,
  listSNSTopics,
  listECRRepositories,
  listSecretsManagerSecrets,
  listCloudFrontDistributions,
  listIAMUsers,
} from "../resource-listers.js";
import {
  listRoute53HostedZones,
  listRoute53RecordSets,
  listRoute53HealthChecks,
  listALBs,
  listTargetGroups,
  listSecurityGroups,
  listSubnets,
  listRouteTables,
  listNATGateways,
  listInternetGateways,
  listAppRunnerServices,
  listBatchJobQueues,
  listSageMakerEndpoints,
  listRDSClusters,
  listNeptuneClusters,
  listDocumentDBClusters,
  listDBSubnetGroups,
  listEFSFileSystems,
  listKinesisStreams,
  listMSKClusters,
  listMQBrokers,
  listEventBridgeRules,
  listStepFunctions,
  listIAMRoles,
  listACMCertificates,
  listWAFWebACLs,
  listSSMParameters,
  listCognitoUserPools,
  listCodeBuildProjects,
  listCodePipelines,
  listCloudFormationStacks,
  listGlueDatabases,
  listAPIGateways,
  listCloudWatchAlarms,
  listCloudWatchLogGroups,
  listBackupVaults,
} from "../resource-listers-extended.js";
import { collectPages, queryString } from "../paginate.js";
import { parseXml } from "../xml.js";

type Method = "ec2" | "json" | "jsonGet" | "restJson" | "ec2Query" | "xmlGet";
type Args = unknown[];
type Lister = (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>;

interface PageCase {
  name: string;
  lister: Lister;
  method: Method;
  /** True for the paged list call (as opposed to a per-item describe). */
  isList: (args: Args) => boolean;
  /** The continuation token the request carried, if any. */
  token: (args: Args) => string | undefined;
  /** The token page one hands out; page two must be requested with it. */
  next: string;
  /** Page bodies: XML strings run through `parseXml`, objects returned as JSON. */
  pages: [string | object, string | object];
  /** Answers for any non-list call the lister makes per item. */
  detail?: (method: Method, args: Args) => unknown;
  /** Page size the first request must ask for, as `[param, value]`. */
  pageSize?: (args: Args) => unknown;
  expectedPageSize?: unknown;
  expected: string[];
}

/** Read a query-string param off a path argument (`jsonGet`/`xmlGet`/`restJson`). */
const query =
  (name: string, index = 1) =>
  (args: Args): string | undefined =>
    new URL(`https://aws.test${String(args[index] ?? "")}`).searchParams.get(name) ?? undefined;

/** Read a field off a params/body argument. */
const param =
  (name: string, index: number) =>
  (args: Args): string | undefined => {
    const value = (args[index] as Record<string, unknown> | undefined)?.[name];
    return value == null ? undefined : String(value);
  };

function respond(body: string | object): unknown {
  return typeof body === "string" ? parseXml(body) : body;
}

function runCase(c: PageCase) {
  const listCalls: Args[] = [];
  const handle = (method: Method) =>
    vi.fn(async (...args: Args) => {
      if (method === c.method && c.isList(args)) {
        listCalls.push(args);
        const token = c.token(args);
        if (token === undefined) return respond(c.pages[0]);
        if (token === c.next) return respond(c.pages[1]);
        throw new Error(`unexpected token ${token}`);
      }
      return c.detail?.(method, args) ?? {};
    });
  const ctx = {
    ec2: handle("ec2"),
    json: handle("json"),
    jsonGet: handle("jsonGet"),
    restJson: handle("restJson"),
    ec2Query: handle("ec2Query"),
    xmlGet: handle("xmlGet"),
    id: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00Z",
    region: "us-east-1",
    creds: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" },
  } as unknown as ListerContext;
  return { ctx, listCalls };
}

// --- Query-protocol XML (RDS family, ElastiCache, SNS, IAM, CloudWatch, CloudFormation, ELBv2) ---

const RDS_NS = "http://rds.amazonaws.com/doc/2014-10-31/";

function rdsInstancesXml(ids: string[], marker?: string): string {
  return `<DescribeDBInstancesResponse xmlns="${RDS_NS}">
  <DescribeDBInstancesResult>
    ${marker ? `<Marker>${marker}</Marker>` : ""}
    <DBInstances>
      ${ids
        .map(
          (id) => `<DBInstance>
        <DBInstanceIdentifier>${id}</DBInstanceIdentifier>
        <DBInstanceArn>arn:aws:rds:us-east-1:1234567890:db:${id}</DBInstanceArn>
        <Engine>mysql</Engine>
        <DBInstanceStatus>available</DBInstanceStatus>
      </DBInstance>`,
        )
        .join("")}
    </DBInstances>
  </DescribeDBInstancesResult>
  <ResponseMetadata><RequestId>298f362b-e14a-4ee0-9840-4546c276014a</RequestId></ResponseMetadata>
</DescribeDBInstancesResponse>`;
}

function dbClustersXml(clusters: Array<[string, string]>, marker?: string): string {
  return `<DescribeDBClustersResponse xmlns="${RDS_NS}">
  <DescribeDBClustersResult>
    ${marker ? `<Marker>${marker}</Marker>` : ""}
    <DBClusters>
      ${clusters
        .map(
          ([id, engine]) => `<DBCluster>
        <Engine>${engine}</Engine>
        <Status>available</Status>
        <DBClusterIdentifier>${id}</DBClusterIdentifier>
      </DBCluster>`,
        )
        .join("")}
    </DBClusters>
  </DescribeDBClustersResult>
  <ResponseMetadata><RequestId>d682b02c-1383-11b4-a6bb-172dfac7f170</RequestId></ResponseMetadata>
</DescribeDBClustersResponse>`;
}

function dbSubnetGroupsXml(names: string[], marker?: string): string {
  return `<DescribeDBSubnetGroupsResponse xmlns="${RDS_NS}">
  <DescribeDBSubnetGroupsResult>
    ${marker ? `<Marker>${marker}</Marker>` : ""}
    <DBSubnetGroups>
      ${names
        .map(
          (name) => `<DBSubnetGroup>
        <VpcId>vpc-e7abbdce</VpcId>
        <SubnetGroupStatus>Complete</SubnetGroupStatus>
        <DBSubnetGroupName>${name}</DBSubnetGroupName>
        <Subnets><Subnet><SubnetIdentifier>subnet-e8b3e5b1</SubnetIdentifier></Subnet></Subnets>
      </DBSubnetGroup>`,
        )
        .join("")}
    </DBSubnetGroups>
  </DescribeDBSubnetGroupsResult>
  <ResponseMetadata><RequestId>b783db3b-b98c-11d3-fbc7-5c0aad74da7c</RequestId></ResponseMetadata>
</DescribeDBSubnetGroupsResponse>`;
}

function cacheClustersXml(ids: string[], marker?: string): string {
  return `<DescribeCacheClustersResponse xmlns="http://elasticache.amazonaws.com/doc/2015-02-02/">
  <DescribeCacheClustersResult>
    ${marker ? `<Marker>${marker}</Marker>` : ""}
    <CacheClusters>
      ${ids
        .map(
          (id) => `<CacheCluster>
        <CacheClusterId>${id}</CacheClusterId>
        <CacheClusterStatus>available</CacheClusterStatus>
        <Engine>memcached</Engine>
      </CacheCluster>`,
        )
        .join("")}
    </CacheClusters>
  </DescribeCacheClustersResult>
  <ResponseMetadata><RequestId>f270d58f-b7fb-11e0-9326-b7275b9d4a6c</RequestId></ResponseMetadata>
</DescribeCacheClustersResponse>`;
}

function snsTopicsXml(names: string[], nextToken?: string): string {
  return `<ListTopicsResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <ListTopicsResult>
    <Topics>
      ${names.map((n) => `<member><TopicArn>arn:aws:sns:us-east-1:123456789012:${n}</TopicArn></member>`).join("")}
    </Topics>
    ${nextToken ? `<NextToken>${nextToken}</NextToken>` : ""}
  </ListTopicsResult>
  <ResponseMetadata><RequestId>3f1478c7-33a9-11df-9540-99d0768312d3</RequestId></ResponseMetadata>
</ListTopicsResponse>`;
}

function iamUsersXml(names: string[], marker?: string): string {
  return `<ListUsersResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
 <ListUsersResult>
    <Users>
      ${names
        .map(
          (n) => `<member>
          <UserId>AID2MAB8DPLSRHEXAMPLE</UserId>
          <Path>/division_abc/subdivision_xyz/engineering/</Path>
          <UserName>${n}</UserName>
          <Arn>arn:aws:iam::123456789012:user/division_abc/subdivision_xyz/engineering/${n}</Arn>
       </member>`,
        )
        .join("")}
    </Users>
    <IsTruncated>${marker ? "true" : "false"}</IsTruncated>
    ${marker ? `<Marker>${marker}</Marker>` : ""}
 </ListUsersResult>
 <ResponseMetadata><RequestId>7a62c49f-347e-11e0-9331-6e8eEXAMPLE</RequestId></ResponseMetadata>
</ListUsersResponse>`;
}

function iamRolesXml(names: string[], marker?: string): string {
  return `<ListRolesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
<ListRolesResult>
  <IsTruncated>${marker ? "true" : "false"}</IsTruncated>
  ${marker ? `<Marker>${marker}</Marker>` : ""}
  <Roles>
    ${names
      .map(
        (n) => `<member>
      <Path>/application_abc/component_xyz/</Path>
      <Arn>arn:aws:iam::123456789012:role/application_abc/component_xyz/${n}</Arn>
      <RoleName>${n}</RoleName>
      <RoleId>AROACVSVTSZYEXAMPLEYK</RoleId>
    </member>`,
      )
      .join("")}
  </Roles>
</ListRolesResult>
<ResponseMetadata><RequestId>20f7279f-99ee-11e1-a4c3-27EXAMPLE804</RequestId></ResponseMetadata>
</ListRolesResponse>`;
}

function alarmsXml(names: string[], nextToken?: string): string {
  return `<DescribeAlarmsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">
  <DescribeAlarmsResult>
    <MetricAlarms>
      ${names
        .map(
          (n) => `<member>
        <AlarmName>${n}</AlarmName>
        <AlarmArn>arn:aws:cloudwatch:us-east-1:123456789012:alarm:${n}</AlarmArn>
        <StateValue>OK</StateValue>
        <MetricName>CPUUtilization</MetricName>
        <Namespace>AWS/EC2</Namespace>
      </member>`,
        )
        .join("")}
    </MetricAlarms>
    ${nextToken ? `<NextToken>${nextToken}</NextToken>` : ""}
  </DescribeAlarmsResult>
  <ResponseMetadata><RequestId>f9a8c1b2-0000-11e5-94eb-example</RequestId></ResponseMetadata>
</DescribeAlarmsResponse>`;
}

function stacksXml(names: string[], nextToken?: string): string {
  return `<DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/">
  <DescribeStacksResult>
    <Stacks>
      ${names
        .map(
          (n) => `<member>
        <StackName>${n}</StackName>
        <StackId>arn:aws:cloudformation:us-east-1:123456789:stack/${n}/aaf549a0-a413-11df-adb3-5081b3858e83</StackId>
        <StackStatus>CREATE_COMPLETE</StackStatus>
      </member>`,
        )
        .join("")}
    </Stacks>
    ${nextToken ? `<NextToken>${nextToken}</NextToken>` : ""}
  </DescribeStacksResult>
  <ResponseMetadata><RequestId>b9b4b068-3a41-11e5-94eb-example</RequestId></ResponseMetadata>
</DescribeStacksResponse>`;
}

const ELB_NS = "http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/";

function loadBalancersXml(names: string[], nextMarker?: string): string {
  return `<DescribeLoadBalancersResponse xmlns="${ELB_NS}">
  <DescribeLoadBalancersResult>
    <LoadBalancers>
      ${names
        .map(
          (n) => `<member>
        <LoadBalancerArn>arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/${n}/50dc6c495c0c9188</LoadBalancerArn>
        <LoadBalancerName>${n}</LoadBalancerName>
        <Type>application</Type>
      </member>`,
        )
        .join("")}
    </LoadBalancers>
    ${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : ""}
  </DescribeLoadBalancersResult>
  <ResponseMetadata><RequestId>6581c0ac-f39f-11e5-bb98-57195a6eb84a</RequestId></ResponseMetadata>
</DescribeLoadBalancersResponse>`;
}

function targetGroupsXml(names: string[], nextMarker?: string): string {
  return `<DescribeTargetGroupsResponse xmlns="${ELB_NS}">
  <DescribeTargetGroupsResult>
    <TargetGroups>
      ${names
        .map(
          (n) => `<member>
        <TargetGroupArn>arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${n}/73e2d6bc24d8a067</TargetGroupArn>
        <TargetGroupName>${n}</TargetGroupName>
        <Protocol>HTTP</Protocol>
      </member>`,
        )
        .join("")}
    </TargetGroups>
    ${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : ""}
  </DescribeTargetGroupsResult>
  <ResponseMetadata><RequestId>70092c0e-f3a9-11e5-ae48-cff02092876b</RequestId></ResponseMetadata>
</DescribeTargetGroupsResponse>`;
}

// --- EC2 Query (nextToken directly under the response root) ---

function ec2Xml(root: string, setKey: string, items: string[], nextToken?: string): string {
  return `<${root} xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
  <${setKey}>${items.map((i) => `<item>${i}</item>`).join("")}</${setKey}>
  ${nextToken ? `<nextToken>${nextToken}</nextToken>` : ""}
</${root}>`;
}

const reservation = (id: string) =>
  `<reservationId>r-${id}</reservationId><instancesSet><item><instanceId>${id}</instanceId><imageId>ami-1</imageId><instanceState><name>running</name></instanceState><instanceType>t3.micro</instanceType></item></instancesSet>`;

// --- REST-XML (S3, CloudFront, Route 53) ---

function bucketsXml(names: string[], continuationToken?: string): string {
  return `<ListAllMyBucketsResult>
<Buckets>
${names.map((n) => `<Bucket><CreationDate>2024-11-14T23:32:47+00:00</CreationDate><Name>${n}</Name><BucketRegion>us-east-1</BucketRegion></Bucket>`).join("")}
</Buckets>
<Owner><ID>AIDACKCEVSQ6C2EXAMPLE</ID></Owner>
${continuationToken ? `<ContinuationToken>${continuationToken}</ContinuationToken>` : ""}
</ListAllMyBucketsResult>`;
}

function distributionsXml(ids: string[], nextMarker?: string): string {
  return `<DistributionList xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
<IsTruncated>${nextMarker ? "true" : "false"}</IsTruncated>
<Items>
${ids.map((id) => `<DistributionSummary><ARN>arn:aws:cloudfront::123456789012:distribution/${id}</ARN><DomainName>${id.toLowerCase()}.cloudfront.net</DomainName><Id>${id}</Id><Enabled>true</Enabled><Status>Deployed</Status></DistributionSummary>`).join("")}
</Items>
<Marker></Marker>
<MaxItems>100</MaxItems>
${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : ""}
<Quantity>${ids.length}</Quantity>
</DistributionList>`;
}

const R53_NS = "https://route53.amazonaws.com/doc/2013-04-01/";

function hostedZonesXml(ids: string[], nextMarker?: string): string {
  return `<ListHostedZonesResponse xmlns="${R53_NS}">
<HostedZones>
${ids.map((id) => `<HostedZone><Id>/hostedzone/${id}</Id><Name>${id.toLowerCase()}.example.com.</Name><CallerReference>2017-03-01T11:22:14Z</CallerReference><Config><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>42</ResourceRecordSetCount></HostedZone>`).join("")}
</HostedZones>
<IsTruncated>${nextMarker ? "true" : "false"}</IsTruncated>
${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : ""}
<MaxItems>100</MaxItems>
</ListHostedZonesResponse>`;
}

function healthChecksXml(ids: string[], nextMarker?: string): string {
  return `<ListHealthChecksResponse xmlns="${R53_NS}">
<HealthChecks>
${ids.map((id) => `<HealthCheck><Id>${id}</Id><CallerReference>example.com 192.0.2.17</CallerReference><HealthCheckConfig><Type>HTTP</Type></HealthCheckConfig><HealthCheckVersion>2</HealthCheckVersion></HealthCheck>`).join("")}
</HealthChecks>
<IsTruncated>${nextMarker ? "true" : "false"}</IsTruncated>
${nextMarker ? `<NextMarker>${nextMarker}</NextMarker>` : ""}
<MaxItems>1000</MaxItems>
</ListHealthChecksResponse>`;
}

const CASES: PageCase[] = [
  // Query XML
  {
    name: "listRDSInstances (Marker, MaxRecords 100)",
    lister: listRDSInstances,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeDBInstances",
    token: param("Marker", 3),
    pageSize: param("MaxRecords", 3),
    expectedPageSize: "100",
    next: "mysqldb-2",
    pages: [rdsInstancesXml(["db-1", "db-2"], "mysqldb-2"), rdsInstancesXml(["db-3"])],
    expected: ["db-1", "db-2", "db-3"],
  },
  {
    name: "listElastiCacheClusters (Marker, MaxRecords 100)",
    lister: listElastiCacheClusters,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeCacheClusters",
    token: param("Marker", 3),
    pageSize: param("MaxRecords", 3),
    expectedPageSize: "100",
    next: "simcoprod43",
    pages: [
      cacheClustersXml(["simcoprod41", "simcoprod42"], "simcoprod43"),
      cacheClustersXml(["simcoprod43"]),
    ],
    expected: ["simcoprod41", "simcoprod42", "simcoprod43"],
  },
  {
    name: "listSNSTopics (NextToken in ListTopicsResult)",
    lister: listSNSTopics,
    method: "ec2Query",
    isList: (a) => a[1] === "ListTopics",
    token: param("NextToken", 3),
    next: "AAAAAAAAAAAAAAAAAAAAAAAA",
    pages: [
      snsTopicsXml(["Orders", "Payments"], "AAAAAAAAAAAAAAAAAAAAAAAA"),
      snsTopicsXml(["Refunds"]),
    ],
    expected: ["Orders", "Payments", "Refunds"],
  },
  {
    name: "listIAMUsers (IsTruncated + Marker, MaxItems 1000)",
    lister: listIAMUsers,
    method: "ec2Query",
    isList: (a) => a[1] === "ListUsers",
    token: param("Marker", 3),
    pageSize: param("MaxItems", 3),
    expectedPageSize: "1000",
    next: "AAEXAMPLEMARKER",
    pages: [iamUsersXml(["Andrew", "Jackie"], "AAEXAMPLEMARKER"), iamUsersXml(["Kim"])],
    expected: ["Andrew", "Jackie", "Kim"],
  },
  {
    name: "listIAMRoles (IsTruncated + Marker, MaxItems 1000)",
    lister: listIAMRoles,
    method: "ec2Query",
    isList: (a) => a[1] === "ListRoles",
    token: param("Marker", 3),
    pageSize: param("MaxItems", 3),
    expectedPageSize: "1000",
    next: "AAROLEMARKER",
    pages: [iamRolesXml(["S3Access", "SQSAccess"], "AAROLEMARKER"), iamRolesXml(["EC2Access"])],
    expected: ["S3Access", "SQSAccess", "EC2Access"],
  },
  {
    name: "listRDSClusters (Marker, MaxRecords 100)",
    lister: listRDSClusters,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeDBClusters",
    token: param("Marker", 3),
    pageSize: param("MaxRecords", 3),
    expectedPageSize: "100",
    next: "sample-cluster3",
    pages: [
      dbClustersXml(
        [
          ["sample-cluster1", "aurora-mysql"],
          ["sample-cluster2", "aurora-mysql"],
        ],
        "sample-cluster3",
      ),
      dbClustersXml([["sample-cluster3", "aurora-postgresql"]]),
    ],
    expected: ["sample-cluster1", "sample-cluster2", "sample-cluster3"],
  },
  {
    name: "listNeptuneClusters (Marker, MaxRecords 100)",
    lister: listNeptuneClusters,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeDBClusters",
    token: param("Marker", 3),
    next: "graph-3",
    pages: [
      dbClustersXml(
        [
          ["graph-1", "neptune"],
          ["graph-2", "neptune"],
        ],
        "graph-3",
      ),
      dbClustersXml([["graph-3", "neptune"]]),
    ],
    expected: ["graph-1", "graph-2", "graph-3"],
  },
  {
    name: "listDocumentDBClusters (Marker, MaxRecords 100)",
    lister: listDocumentDBClusters,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeDBClusters",
    token: param("Marker", 3),
    next: "docs-3",
    pages: [
      dbClustersXml(
        [
          ["docs-1", "docdb"],
          ["docs-2", "docdb"],
        ],
        "docs-3",
      ),
      dbClustersXml([["docs-3", "docdb"]]),
    ],
    expected: ["docs-1", "docs-2", "docs-3"],
  },
  {
    name: "listDBSubnetGroups (Marker, MaxRecords 100)",
    lister: listDBSubnetGroups,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeDBSubnetGroups",
    token: param("Marker", 3),
    pageSize: param("MaxRecords", 3),
    expectedPageSize: "100",
    next: "mydbsubnetgroup3",
    pages: [
      dbSubnetGroupsXml(["mydbsubnetgroup1", "mydbsubnetgroup2"], "mydbsubnetgroup3"),
      dbSubnetGroupsXml(["mydbsubnetgroup3"]),
    ],
    expected: ["mydbsubnetgroup1", "mydbsubnetgroup2", "mydbsubnetgroup3"],
  },
  {
    name: "listCloudWatchAlarms (NextToken, MaxRecords 100)",
    lister: listCloudWatchAlarms,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeAlarms",
    token: param("NextToken", 3),
    pageSize: param("MaxRecords", 3),
    expectedPageSize: "100",
    next: "alarms-page-2",
    pages: [alarmsXml(["cpu-high", "cpu-low"], "alarms-page-2"), alarmsXml(["disk-full"])],
    expected: ["cpu-high", "cpu-low", "disk-full"],
  },
  {
    name: "listCloudFormationStacks (NextToken)",
    lister: listCloudFormationStacks,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeStacks",
    token: param("NextToken", 3),
    next: "stacks-page-2",
    pages: [stacksXml(["MyStack", "Network"], "stacks-page-2"), stacksXml(["Data"])],
    expected: ["MyStack", "Network", "Data"],
  },
  {
    name: "listALBs (Marker in, NextMarker out, PageSize 400)",
    lister: listALBs,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeLoadBalancers",
    token: param("Marker", 3),
    pageSize: param("PageSize", 3),
    expectedPageSize: "400",
    next: "lb-page-2",
    pages: [
      loadBalancersXml(["my-load-balancer", "api"], "lb-page-2"),
      loadBalancersXml(["internal"]),
    ],
    expected: ["my-load-balancer", "api", "internal"],
  },
  {
    name: "listTargetGroups (Marker in, NextMarker out, PageSize 400)",
    lister: listTargetGroups,
    method: "ec2Query",
    isList: (a) => a[1] === "DescribeTargetGroups",
    token: param("Marker", 3),
    next: "tg-page-2",
    pages: [targetGroupsXml(["my-targets", "api-targets"], "tg-page-2"), targetGroupsXml(["web"])],
    expected: ["my-targets", "api-targets", "web"],
  },
  // EC2 Query
  {
    name: "listEC2Instances (nextToken, MaxResults 1000)",
    lister: listEC2Instances,
    method: "ec2",
    isList: (a) => a[0] === "DescribeInstances",
    token: param("NextToken", 1),
    pageSize: param("MaxResults", 1),
    expectedPageSize: "1000",
    next: "eyJOZXh0VG9rZW4iOiBudWxsfQ==",
    pages: [
      ec2Xml(
        "DescribeInstancesResponse",
        "reservationSet",
        [reservation("i-1"), reservation("i-2")],
        "eyJOZXh0VG9rZW4iOiBudWxsfQ==",
      ),
      ec2Xml("DescribeInstancesResponse", "reservationSet", [reservation("i-3")]),
    ],
    expected: ["i-1", "i-2", "i-3"],
  },
  {
    name: "listEBSVolumes (nextToken)",
    lister: listEBSVolumes,
    method: "ec2",
    isList: (a) => a[0] === "DescribeVolumes",
    token: param("NextToken", 1),
    next: "vol-token",
    pages: [
      ec2Xml(
        "DescribeVolumesResponse",
        "volumeSet",
        ["<volumeId>vol-1</volumeId><size>80</size>", "<volumeId>vol-2</volumeId><size>8</size>"],
        "vol-token",
      ),
      ec2Xml("DescribeVolumesResponse", "volumeSet", ["<volumeId>vol-3</volumeId><size>8</size>"]),
    ],
    expected: ["vol-1", "vol-2", "vol-3"],
  },
  {
    name: "listVPCs (nextToken)",
    lister: listVPCs,
    method: "ec2",
    isList: (a) => a[0] === "DescribeVpcs",
    token: param("NextToken", 1),
    next: "vpc-token",
    pages: [
      ec2Xml(
        "DescribeVpcsResponse",
        "vpcSet",
        ["<vpcId>vpc-1</vpcId>", "<vpcId>vpc-2</vpcId>"],
        "vpc-token",
      ),
      ec2Xml("DescribeVpcsResponse", "vpcSet", ["<vpcId>vpc-3</vpcId>"]),
    ],
    expected: ["vpc-1", "vpc-2", "vpc-3"],
  },
  {
    name: "listSecurityGroups (nextToken)",
    lister: listSecurityGroups,
    method: "ec2",
    isList: (a) => a[0] === "DescribeSecurityGroups",
    token: param("NextToken", 1),
    next: "sg-token",
    pages: [
      ec2Xml(
        "DescribeSecurityGroupsResponse",
        "securityGroupInfo",
        ["<groupId>sg-1</groupId>", "<groupId>sg-2</groupId>"],
        "sg-token",
      ),
      ec2Xml("DescribeSecurityGroupsResponse", "securityGroupInfo", ["<groupId>sg-3</groupId>"]),
    ],
    expected: ["sg-1", "sg-2", "sg-3"],
  },
  {
    name: "listSubnets (nextToken)",
    lister: listSubnets,
    method: "ec2",
    isList: (a) => a[0] === "DescribeSubnets",
    token: param("NextToken", 1),
    next: "subnet-token",
    pages: [
      ec2Xml(
        "DescribeSubnetsResponse",
        "subnetSet",
        ["<subnetId>subnet-1</subnetId>", "<subnetId>subnet-2</subnetId>"],
        "subnet-token",
      ),
      ec2Xml("DescribeSubnetsResponse", "subnetSet", ["<subnetId>subnet-3</subnetId>"]),
    ],
    expected: ["subnet-1", "subnet-2", "subnet-3"],
  },
  {
    name: "listRouteTables (nextToken, MaxResults 100)",
    lister: listRouteTables,
    method: "ec2",
    isList: (a) => a[0] === "DescribeRouteTables",
    token: param("NextToken", 1),
    pageSize: param("MaxResults", 1),
    expectedPageSize: "100",
    next: "rtb-token",
    pages: [
      ec2Xml(
        "DescribeRouteTablesResponse",
        "routeTableSet",
        ["<routeTableId>rtb-1</routeTableId>", "<routeTableId>rtb-2</routeTableId>"],
        "rtb-token",
      ),
      ec2Xml("DescribeRouteTablesResponse", "routeTableSet", [
        "<routeTableId>rtb-3</routeTableId>",
      ]),
    ],
    expected: ["rtb-1", "rtb-2", "rtb-3"],
  },
  {
    name: "listNATGateways (nextToken)",
    lister: listNATGateways,
    method: "ec2",
    isList: (a) => a[0] === "DescribeNatGateways",
    token: param("NextToken", 1),
    next: "nat-token",
    pages: [
      ec2Xml(
        "DescribeNatGatewaysResponse",
        "natGatewaySet",
        ["<natGatewayId>nat-1</natGatewayId>", "<natGatewayId>nat-2</natGatewayId>"],
        "nat-token",
      ),
      ec2Xml("DescribeNatGatewaysResponse", "natGatewaySet", [
        "<natGatewayId>nat-3</natGatewayId>",
      ]),
    ],
    expected: ["nat-1", "nat-2", "nat-3"],
  },
  {
    name: "listInternetGateways (nextToken)",
    lister: listInternetGateways,
    method: "ec2",
    isList: (a) => a[0] === "DescribeInternetGateways",
    token: param("NextToken", 1),
    next: "igw-token",
    pages: [
      ec2Xml(
        "DescribeInternetGatewaysResponse",
        "internetGatewaySet",
        [
          "<internetGatewayId>igw-1</internetGatewayId>",
          "<internetGatewayId>igw-2</internetGatewayId>",
        ],
        "igw-token",
      ),
      ec2Xml("DescribeInternetGatewaysResponse", "internetGatewaySet", [
        "<internetGatewayId>igw-3</internetGatewayId>",
      ]),
    ],
    expected: ["igw-1", "igw-2", "igw-3"],
  },
  // REST-XML
  {
    name: "listS3Buckets (continuation-token, max-buckets 10000)",
    lister: listS3Buckets,
    method: "xmlGet",
    isList: () => true,
    token: query("continuation-token"),
    pageSize: query("max-buckets"),
    expectedPageSize: "10000",
    next: "eyJNYXJrZXIiOiBudWxsLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAxfQ==",
    pages: [
      bucketsXml(
        ["amzn-s3-demo-bucket", "amzn-s3-demo-bucket1"],
        "eyJNYXJrZXIiOiBudWxsLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAxfQ==",
      ),
      bucketsXml(["amzn-s3-demo-bucket2"]),
    ],
    expected: ["amzn-s3-demo-bucket", "amzn-s3-demo-bucket1", "amzn-s3-demo-bucket2"],
  },
  {
    name: "listCloudFrontDistributions (Marker, IsTruncated/NextMarker)",
    lister: listCloudFrontDistributions,
    method: "xmlGet",
    isList: () => true,
    token: query("Marker"),
    pageSize: query("MaxItems"),
    expectedPageSize: "100",
    next: "EDFDVBD6EXAMPLE",
    pages: [
      distributionsXml(["EMLARXS9EXAMPLE", "EGTXBD79EXAMPLE"], "EDFDVBD6EXAMPLE"),
      distributionsXml(["EDFDVBD6EXAMPLE"]),
    ],
    expected: ["EMLARXS9EXAMPLE", "EGTXBD79EXAMPLE", "EDFDVBD6EXAMPLE"],
  },
  {
    name: "listRoute53HostedZones (marker, IsTruncated/NextMarker)",
    lister: listRoute53HostedZones,
    method: "xmlGet",
    isList: () => true,
    token: query("marker"),
    pageSize: query("maxitems"),
    expectedPageSize: "100",
    next: "Z222222VVVVVVV",
    pages: [
      hostedZonesXml(["Z111111QQQQQQQ", "Z1D633PJN98FT9"], "Z222222VVVVVVV"),
      hostedZonesXml(["Z222222VVVVVVV"]),
    ],
    expected: ["Z111111QQQQQQQ", "Z1D633PJN98FT9", "Z222222VVVVVVV"],
  },
  {
    name: "listRoute53HealthChecks (marker, IsTruncated/NextMarker)",
    lister: listRoute53HealthChecks,
    method: "xmlGet",
    isList: () => true,
    token: query("marker"),
    next: "aaaaaaaa-1234-5678-9012-bbbbbbcccccc",
    pages: [
      healthChecksXml(
        ["abcdef11-2222-3333-4444-555555fedcba", "abcdef22-2222-3333-4444-555555fedcba"],
        "aaaaaaaa-1234-5678-9012-bbbbbbcccccc",
      ),
      healthChecksXml(["aaaaaaaa-1234-5678-9012-bbbbbbcccccc"]),
    ],
    expected: [
      "abcdef11-2222-3333-4444-555555fedcba",
      "abcdef22-2222-3333-4444-555555fedcba",
      "aaaaaaaa-1234-5678-9012-bbbbbbcccccc",
    ],
  },
  // JSON (Amz-Target)
  {
    name: "listECSServices clusters (nextToken, maxResults 100)",
    lister: listECSServices,
    method: "json",
    isList: (a) => a[1] === "AmazonEC2ContainerServiceV20141113.ListClusters",
    token: param("nextToken", 2),
    pageSize: param("maxResults", 2),
    expectedPageSize: "100",
    next: "clusters-2",
    pages: [
      {
        clusterArns: [
          "arn:aws:ecs:us-east-1:012345678910:cluster/a",
          "arn:aws:ecs:us-east-1:012345678910:cluster/b",
        ],
        nextToken: "clusters-2",
      },
      { clusterArns: ["arn:aws:ecs:us-east-1:012345678910:cluster/c"], nextToken: null },
    ],
    detail: (_m, a) => {
      const cluster = String((a[2] as Record<string, unknown>)["cluster"])
        .split("/")
        .pop();
      if (a[1] === "AmazonEC2ContainerServiceV20141113.ListServices")
        return { serviceArns: [`arn:aws:ecs:us-east-1:012345678910:service/${cluster}/web`] };
      if (a[1] === "AmazonEC2ContainerServiceV20141113.DescribeServices")
        return { services: [{ serviceName: "web" }], failures: [] };
      return {};
    },
    expected: ["a/web", "b/web", "c/web"],
  },
  {
    name: "listDynamoDBTables (ExclusiveStartTableName / LastEvaluatedTableName)",
    lister: listDynamoDBTables,
    method: "json",
    isList: (a) => a[1] === "DynamoDB_20120810.ListTables",
    token: param("ExclusiveStartTableName", 2),
    pageSize: param("Limit", 2),
    expectedPageSize: "100",
    next: "Reply",
    pages: [
      { LastEvaluatedTableName: "Reply", TableNames: ["Forum", "Reply"] },
      { TableNames: ["Thread"] },
    ],
    detail: (_m, a) => ({
      Table: { TableName: (a[2] as Record<string, unknown>)["TableName"], TableStatus: "ACTIVE" },
    }),
    expected: ["Forum", "Reply", "Thread"],
  },
  {
    name: "listSQSQueues (NextToken, MaxResults 1000)",
    lister: listSQSQueues,
    method: "json",
    isList: (a) => a[1] === "AmazonSQS.ListQueues",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "1000",
    next: "queues-2",
    pages: [
      {
        QueueUrls: [
          "https://sqs.us-east-1.amazonaws.com/177715257436/MyQueue",
          "https://sqs.us-east-1.amazonaws.com/177715257436/Orders",
        ],
        NextToken: "queues-2",
      },
      { QueueUrls: ["https://sqs.us-east-1.amazonaws.com/177715257436/Refunds"] },
    ],
    detail: () => ({ Attributes: { QueueArn: "arn" } }),
    expected: ["MyQueue", "Orders", "Refunds"],
  },
  {
    name: "listECRRepositories (nextToken, maxResults 1000)",
    lister: listECRRepositories,
    method: "json",
    isList: (a) => a[1] === "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
    token: param("nextToken", 2),
    pageSize: param("maxResults", 2),
    expectedPageSize: "1000",
    next: "repos-2",
    pages: [
      {
        repositories: [
          {
            repositoryName: "sample-repo",
            repositoryUri: "012345678910.dkr.ecr.us-west-2.amazonaws.com/sample-repo",
          },
          {
            repositoryName: "api",
            repositoryUri: "012345678910.dkr.ecr.us-west-2.amazonaws.com/api",
          },
        ],
        nextToken: "repos-2",
      },
      {
        repositories: [
          {
            repositoryName: "web",
            repositoryUri: "012345678910.dkr.ecr.us-west-2.amazonaws.com/web",
          },
        ],
        nextToken: null,
      },
    ],
    expected: ["sample-repo", "api", "web"],
  },
  {
    name: "listSecretsManagerSecrets (NextToken, MaxResults 100)",
    lister: listSecretsManagerSecrets,
    method: "json",
    isList: (a) => a[1] === "secretsmanager.ListSecrets",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "100",
    next: "secrets-2",
    pages: [
      {
        SecretList: [{ Name: "MyTestDatabaseSecret" }, { Name: "ApiKey" }],
        NextToken: "secrets-2",
      },
      { SecretList: [{ Name: "Webhook" }] },
    ],
    expected: ["MyTestDatabaseSecret", "ApiKey", "Webhook"],
  },
  {
    name: "listAppRunnerServices (NextToken, MaxResults 20)",
    lister: listAppRunnerServices,
    method: "json",
    isList: (a) => a[1] === "AppRunner.ListServices",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "20",
    next: "eyJDdXN0b21l",
    pages: [
      {
        NextToken: "eyJDdXN0b21l",
        ServiceSummaryList: [
          { ServiceName: "python-app", Status: "RUNNING" },
          { ServiceName: "golang-app", Status: "RUNNING" },
        ],
      },
      { ServiceSummaryList: [{ ServiceName: "node-app", Status: "RUNNING" }] },
    ],
    expected: ["python-app", "golang-app", "node-app"],
  },
  {
    name: "listSageMakerEndpoints (NextToken, MaxResults 100)",
    lister: listSageMakerEndpoints,
    method: "json",
    isList: (a) => a[1] === "SageMaker.ListEndpoints",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "100",
    next: "endpoints-2",
    pages: [
      { Endpoints: [{ EndpointName: "ep-1" }, { EndpointName: "ep-2" }], NextToken: "endpoints-2" },
      { Endpoints: [{ EndpointName: "ep-3" }] },
    ],
    expected: ["ep-1", "ep-2", "ep-3"],
  },
  {
    name: "listCodeBuildProjects (nextToken, no page size)",
    lister: listCodeBuildProjects,
    method: "json",
    isList: (a) => a[1] === "CodeBuild_20161006.ListProjects",
    token: param("nextToken", 2),
    next: "projects-2",
    pages: [
      { projects: ["build-1", "build-2"], nextToken: "projects-2" },
      { projects: ["build-3"] },
    ],
    detail: (_m, a) => ({
      projects: ((a[2] as Record<string, unknown>)["names"] as string[]).map((name) => ({ name })),
    }),
    expected: ["build-1", "build-2", "build-3"],
  },
  {
    name: "listCodePipelines (nextToken, maxResults 1000)",
    lister: listCodePipelines,
    method: "json",
    isList: (a) => a[1] === "CodePipeline_20150709.ListPipelines",
    token: param("nextToken", 2),
    pageSize: param("maxResults", 2),
    expectedPageSize: "1000",
    next: "pipelines-2",
    pages: [
      {
        pipelines: [
          { updated: 1444681408.094, version: 1, name: "MyFirstPipeline", created: 1444681408.094 },
          {
            updated: 1443048299.639,
            version: 3,
            name: "MySecondPipeline",
            created: 1443048299.639,
          },
        ],
        nextToken: "pipelines-2",
      },
      {
        pipelines: [
          { updated: 1443048299.639, version: 1, name: "MyThirdPipeline", created: 1443048299.639 },
        ],
      },
    ],
    expected: ["MyFirstPipeline", "MySecondPipeline", "MyThirdPipeline"],
  },
  {
    name: "listGlueDatabases (NextToken, MaxResults 100)",
    lister: listGlueDatabases,
    method: "json",
    isList: (a) => a[1] === "AWSGlue.GetDatabases",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "100",
    next: "glue-2",
    pages: [
      { DatabaseList: [{ Name: "sales" }, { Name: "events" }], NextToken: "glue-2" },
      { DatabaseList: [{ Name: "logs" }] },
    ],
    expected: ["sales", "events", "logs"],
  },
  {
    name: "listKinesisStreams (NextToken, Limit 100)",
    lister: listKinesisStreams,
    method: "json",
    isList: (a) => a[1] === "Kinesis_20131202.ListStreams",
    token: param("NextToken", 2),
    pageSize: param("Limit", 2),
    expectedPageSize: "100",
    next: "streams-2",
    pages: [
      {
        HasMoreStreams: true,
        StreamNames: ["exampleStreamName", "clicks"],
        NextToken: "streams-2",
      },
      { HasMoreStreams: false, StreamNames: ["orders"] },
    ],
    detail: (_m, a) => ({
      StreamDescription: {
        StreamName: (a[2] as Record<string, unknown>)["StreamName"],
        StreamStatus: "ACTIVE",
        Shards: [],
      },
    }),
    expected: ["exampleStreamName", "clicks", "orders"],
  },
  {
    name: "listEventBridgeRules (NextToken, Limit 100)",
    lister: listEventBridgeRules,
    method: "json",
    isList: (a) => a[1] === "AWSEvents.ListRules",
    token: param("NextToken", 2),
    pageSize: param("Limit", 2),
    expectedPageSize: "100",
    next: "ABCDEgAAAA",
    pages: [
      {
        Rules: [
          {
            Name: "test",
            Arn: "arn:aws:events:us-east-1:123456789012:rule/test",
            State: "DISABLED",
          },
          {
            Name: "nightly",
            Arn: "arn:aws:events:us-east-1:123456789012:rule/nightly",
            State: "ENABLED",
          },
        ],
        NextToken: "ABCDEgAAAA",
      },
      {
        Rules: [
          {
            Name: "hourly",
            Arn: "arn:aws:events:us-east-1:123456789012:rule/hourly",
            State: "ENABLED",
          },
        ],
      },
    ],
    expected: ["test", "nightly", "hourly"],
  },
  {
    name: "listStepFunctions (nextToken, maxResults 1000)",
    lister: listStepFunctions,
    method: "json",
    isList: (a) => a[1] === "AWSStepFunctions.ListStateMachines",
    token: param("nextToken", 2),
    pageSize: param("maxResults", 2),
    expectedPageSize: "1000",
    next: "machines-2",
    pages: [
      {
        stateMachines: [
          {
            name: "Hello",
            stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:Hello",
          },
          {
            name: "Orders",
            stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:Orders",
          },
        ],
        nextToken: "machines-2",
      },
      {
        stateMachines: [
          {
            name: "Refunds",
            stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:Refunds",
          },
        ],
      },
    ],
    expected: ["Hello", "Orders", "Refunds"],
  },
  {
    name: "listCloudWatchLogGroups (nextToken, limit 50)",
    lister: listCloudWatchLogGroups,
    method: "json",
    isList: (a) => a[1] === "Logs_20140328.DescribeLogGroups",
    token: param("nextToken", 2),
    pageSize: param("limit", 2),
    expectedPageSize: "50",
    next: "groups-2",
    pages: [
      {
        logGroups: [{ logGroupName: "/aws/lambda/a" }, { logGroupName: "/aws/lambda/b" }],
        nextToken: "groups-2",
      },
      { logGroups: [{ logGroupName: "/aws/lambda/c" }] },
    ],
    expected: ["/aws/lambda/a", "/aws/lambda/b", "/aws/lambda/c"],
  },
  {
    name: "listACMCertificates (NextToken, MaxItems 1000)",
    lister: listACMCertificates,
    method: "json",
    isList: (a) => a[1] === "CertificateManager.ListCertificates",
    token: param("NextToken", 2),
    pageSize: param("MaxItems", 2),
    expectedPageSize: "1000",
    next: "certs-2",
    pages: [
      {
        CertificateSummaryList: [
          {
            CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/1",
            DomainName: "www.example.com",
          },
          {
            CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/2",
            DomainName: "api.example.com",
          },
        ],
        NextToken: "certs-2",
      },
      {
        CertificateSummaryList: [
          {
            CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/3",
            DomainName: "example.com",
          },
        ],
      },
    ],
    expected: [
      "arn:aws:acm:us-east-1:123456789012:certificate/1",
      "arn:aws:acm:us-east-1:123456789012:certificate/2",
      "arn:aws:acm:us-east-1:123456789012:certificate/3",
    ],
  },
  {
    name: "listWAFWebACLs (NextMarker, Limit 100)",
    lister: listWAFWebACLs,
    method: "json",
    isList: (a) => a[1] === "AWSWAF_20190729.ListWebACLs",
    token: param("NextMarker", 2),
    pageSize: param("Limit", 2),
    expectedPageSize: "100",
    next: "acls-2",
    pages: [
      {
        WebACLs: [
          { Name: "edge", Id: "1" },
          { Name: "api", Id: "2" },
        ],
        NextMarker: "acls-2",
      },
      { WebACLs: [{ Name: "admin", Id: "3" }] },
    ],
    expected: ["edge", "api", "admin"],
  },
  {
    name: "listSSMParameters (NextToken, MaxResults 50)",
    lister: listSSMParameters,
    method: "json",
    isList: (a) => a[1] === "AmazonSSM.DescribeParameters",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "50",
    next: "params-2",
    pages: [
      { Parameters: [{ Name: "/app/db" }, { Name: "/app/key" }], NextToken: "params-2" },
      { Parameters: [{ Name: "/app/url" }] },
    ],
    expected: ["/app/db", "/app/key", "/app/url"],
  },
  {
    name: "listCognitoUserPools (NextToken, MaxResults 60)",
    lister: listCognitoUserPools,
    method: "json",
    isList: (a) => a[1] === "AWSCognitoIdentityProviderService.ListUserPools",
    token: param("NextToken", 2),
    pageSize: param("MaxResults", 2),
    expectedPageSize: "60",
    next: "pools-2",
    pages: [
      {
        NextToken: "pools-2",
        UserPools: [
          { Id: "us-west-2_EXAMPLE1", Name: "user pool 1", CreationDate: 1681502497.741 },
          { Id: "us-west-2_EXAMPLE2", Name: "user pool 2", CreationDate: 1681502497.741 },
        ],
      },
      {
        UserPools: [
          { Id: "us-west-2_EXAMPLE3", Name: "user pool 3", CreationDate: 1681502497.741 },
        ],
      },
    ],
    expected: ["us-west-2_EXAMPLE1", "us-west-2_EXAMPLE2", "us-west-2_EXAMPLE3"],
  },
  // REST JSON
  {
    name: "listEKSClusters (nextToken query, maxResults 100)",
    lister: listEKSClusters,
    method: "jsonGet",
    isList: (a) => String(a[1]).startsWith("/clusters?"),
    token: query("nextToken"),
    pageSize: query("maxResults"),
    expectedPageSize: "100",
    next: "clusters-2",
    pages: [
      { clusters: ["my-cluster", "prod"], nextToken: "clusters-2" },
      { clusters: ["staging"], nextToken: null },
    ],
    detail: (_m, a) => {
      const path = String(a[1]);
      if (path.includes("/node-groups")) return { nodegroups: [], nextToken: null };
      return { cluster: { name: path.split("/").pop(), status: "ACTIVE" } };
    },
    expected: ["my-cluster", "prod", "staging"],
  },
  {
    name: "listBatchJobQueues (nextToken body, maxResults 100)",
    lister: listBatchJobQueues,
    method: "restJson",
    isList: (a) => a[1] === "/v1/describejobqueues",
    token: param("nextToken", 2),
    pageSize: param("maxResults", 2),
    expectedPageSize: "100",
    next: "queues-2",
    pages: [
      {
        jobQueues: [
          { jobQueueName: "HighPriority", state: "ENABLED" },
          { jobQueueName: "LowPriority", state: "ENABLED" },
        ],
        nextToken: "queues-2",
      },
      { jobQueues: [{ jobQueueName: "Batch", state: "ENABLED" }], nextToken: null },
    ],
    expected: ["HighPriority", "LowPriority", "Batch"],
  },
  {
    name: "listBackupVaults (nextToken query, NextToken response)",
    lister: listBackupVaults,
    method: "restJson",
    isList: () => true,
    token: query("nextToken"),
    pageSize: query("maxResults"),
    expectedPageSize: "1000",
    next: "vaults-2",
    pages: [
      {
        BackupVaultList: [{ BackupVaultName: "Default" }, { BackupVaultName: "prod" }],
        NextToken: "vaults-2",
      },
      { BackupVaultList: [{ BackupVaultName: "archive" }] },
    ],
    expected: ["Default", "prod", "archive"],
  },
  {
    name: "listEFSFileSystems (Marker query, NextMarker response)",
    lister: listEFSFileSystems,
    method: "jsonGet",
    isList: () => true,
    token: query("Marker"),
    pageSize: query("MaxItems"),
    expectedPageSize: "100",
    next: "fs-89abcdef",
    pages: [
      {
        FileSystems: [
          {
            OwnerId: "251839141158",
            FileSystemId: "fs-01234567",
            LifeCycleState: "created",
            SizeInBytes: { Value: 6144 },
          },
          {
            OwnerId: "251839141158",
            FileSystemId: "fs-12345678",
            LifeCycleState: "created",
            SizeInBytes: { Value: 6144 },
          },
        ],
        NextMarker: "fs-89abcdef",
      },
      {
        FileSystems: [
          {
            OwnerId: "251839141158",
            FileSystemId: "fs-89abcdef",
            LifeCycleState: "created",
            SizeInBytes: { Value: 6144 },
          },
        ],
      },
    ],
    expected: ["fs-01234567", "fs-12345678", "fs-89abcdef"],
  },
  {
    name: "listMSKClusters (nextToken query, maxResults 100)",
    lister: listMSKClusters,
    method: "jsonGet",
    isList: () => true,
    token: query("nextToken"),
    pageSize: query("maxResults"),
    expectedPageSize: "100",
    next: "msk-2",
    pages: [
      {
        clusterInfoList: [
          { clusterName: "SalesCluster", state: "ACTIVE" },
          { clusterName: "Logs", state: "ACTIVE" },
        ],
        nextToken: "msk-2",
      },
      { clusterInfoList: [{ clusterName: "Events", state: "ACTIVE" }] },
    ],
    expected: ["SalesCluster", "Logs", "Events"],
  },
  {
    name: "listMQBrokers (nextToken query, maxResults 100)",
    lister: listMQBrokers,
    method: "jsonGet",
    isList: () => true,
    token: query("nextToken"),
    pageSize: query("maxResults"),
    expectedPageSize: "100",
    next: "brokers-2",
    pages: [
      {
        brokerSummaries: [
          {
            brokerId: "b-1",
            brokerName: "orders",
            engineType: "ACTIVEMQ",
            deploymentMode: "SINGLE_INSTANCE",
          },
          {
            brokerId: "b-2",
            brokerName: "events",
            engineType: "RABBITMQ",
            deploymentMode: "CLUSTER_MULTI_AZ",
          },
        ],
        nextToken: "brokers-2",
      },
      {
        brokerSummaries: [
          {
            brokerId: "b-3",
            brokerName: "audit",
            engineType: "ACTIVEMQ",
            deploymentMode: "SINGLE_INSTANCE",
          },
        ],
      },
    ],
    expected: ["b-1", "b-2", "b-3"],
  },
  {
    name: "listAPIGateways (nextToken query)",
    lister: listAPIGateways,
    method: "jsonGet",
    isList: () => true,
    token: query("nextToken"),
    next: "apis-2",
    pages: [
      {
        items: [
          { apiId: "a1b2c3", name: "orders", protocolType: "HTTP" },
          { apiId: "d4e5f6", name: "chat", protocolType: "WEBSOCKET" },
        ],
        nextToken: "apis-2",
      },
      { items: [{ apiId: "g7h8i9", name: "admin", protocolType: "HTTP" }] },
    ],
    expected: ["a1b2c3", "d4e5f6", "g7h8i9"],
  },
];

describe("AWS lister pagination", () => {
  it.each(CASES)("$name follows the token to the last page", async (c) => {
    const { ctx, listCalls } = runCase(c);
    const out = await c.lister(ctx, "acct");

    expect(listCalls).toHaveLength(2);
    expect(c.token(listCalls[0]!)).toBeUndefined();
    expect(c.token(listCalls[1]!)).toBe(c.next);
    if (c.pageSize) expect(c.pageSize(listCalls[0]!)).toBe(c.expectedPageSize);
    expect(out.map((r) => r.externalId)).toEqual(c.expected);
  });

  it("listRoute53RecordSets continues from NextRecordName/Type/Identifier", async () => {
    const rrsetXml = (
      records: Array<[string, string]>,
      next?: { name: string; type: string; identifier?: string },
    ) => `<ListResourceRecordSetsResponse xmlns="${R53_NS}">
<ResourceRecordSets>
${records.map(([name, type]) => `<ResourceRecordSet><Name>${name}</Name><Type>${type}</Type><TTL>900</TTL><ResourceRecords><ResourceRecord><Value>192.0.2.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>`).join("")}
</ResourceRecordSets>
<IsTruncated>${next ? "true" : "false"}</IsTruncated>
<MaxItems>300</MaxItems>
${next ? `<NextRecordName>${next.name}</NextRecordName><NextRecordType>${next.type}</NextRecordType>` : ""}
${next?.identifier ? `<NextRecordIdentifier>${next.identifier}</NextRecordIdentifier>` : ""}
</ListResourceRecordSetsResponse>`;

    const rrsetCalls: string[] = [];
    const ctx = runCase({
      ...CASES.find((c) => c.lister === listRoute53HostedZones)!,
      pages: [hostedZonesXml(["Z1D633PJN98FT9"]), hostedZonesXml([])],
    }).ctx;
    ctx.xmlGet = vi.fn(async (_service: string, path?: string) => {
      if (path!.includes("/rrset")) {
        rrsetCalls.push(path!);
        const q = new URL(`https://aws.test${path}`).searchParams;
        if (!q.get("name"))
          return parseXml(
            rrsetXml(
              [
                ["example.com.", "SOA"],
                ["example.com.", "NS"],
              ],
              { name: "www.example.com.", type: "A", identifier: "us-east-1" },
            ),
          );
        return parseXml(rrsetXml([["www.example.com.", "A"]]));
      }
      return parseXml(hostedZonesXml(["Z1D633PJN98FT9"]));
    }) as ListerContext["xmlGet"];

    const out = await listRoute53RecordSets(ctx, "acct");

    expect(rrsetCalls).toHaveLength(2);
    const second = new URL(`https://aws.test${rrsetCalls[1]}`).searchParams;
    expect(second.get("name")).toBe("www.example.com.");
    expect(second.get("type")).toBe("A");
    expect(second.get("identifier")).toBe("us-east-1");
    expect(out.map((r) => `${r.fields.name} ${r.fields.type}`)).toEqual([
      "example.com. SOA",
      "example.com. NS",
      "www.example.com. A",
    ]);
  });

  it("listEKSClusters pages node groups too", async () => {
    const ngPaths: string[] = [];
    const ctx = runCase(CASES.find((c) => c.lister === listEKSClusters)!).ctx;
    ctx.jsonGet = vi.fn(async (_service: string, path: string) => {
      if (path.startsWith("/clusters?")) return { clusters: ["prod"], nextToken: null };
      if (path.startsWith("/clusters/prod/node-groups?")) {
        ngPaths.push(path);
        return path.includes("nextToken=")
          ? { nodegroups: ["standard"], nextToken: null }
          : { nodegroups: ["gpu"], nextToken: "ng-2" };
      }
      if (path.startsWith("/clusters/prod/node-groups/"))
        return { nodegroup: { scalingConfig: { desiredSize: 2 }, instanceTypes: ["m5.large"] } };
      return { cluster: { name: "prod", status: "ACTIVE" } };
    }) as ListerContext["jsonGet"];

    const out = await listEKSClusters(ctx, "acct");

    expect(ngPaths).toEqual([
      "/clusters/prod/node-groups?maxResults=100",
      "/clusters/prod/node-groups?maxResults=100&nextToken=ng-2",
    ]);
    expect(out[0]!.fields).toMatchObject({ nodeGroupCount: 2, nodeCount: 4 });
  });

  it("listECSServices pages ListServices and describes at most 10 services a call", async () => {
    const arns = Array.from(
      { length: 23 },
      (_, i) => `arn:aws:ecs:us-east-1:012345678910:service/main/svc-${i}`,
    );
    const describeBatches: string[][] = [];
    const listServiceTokens: Array<string | undefined> = [];
    const ctx = runCase(CASES.find((c) => c.lister === listECSServices)!).ctx;
    ctx.json = vi.fn(async (_service: string, target: string, body: Record<string, unknown>) => {
      if (target.endsWith(".ListClusters"))
        return { clusterArns: ["arn:aws:ecs:us-east-1:012345678910:cluster/main"] };
      if (target.endsWith(".ListServices")) {
        listServiceTokens.push(body["nextToken"] as string | undefined);
        expect(body["maxResults"]).toBe(100);
        return body["nextToken"]
          ? { serviceArns: arns.slice(20), nextToken: null }
          : { serviceArns: arns.slice(0, 20), nextToken: "svc-2" };
      }
      const batch = body["services"] as string[];
      describeBatches.push(batch);
      return { services: batch.map((arn) => ({ serviceName: arn.split("/").pop() })) };
    }) as ListerContext["json"];

    const out = await listECSServices(ctx, "acct");

    expect(listServiceTokens).toEqual([undefined, "svc-2"]);
    expect(describeBatches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(out).toHaveLength(23);
  });

  it("listCodeBuildProjects describes at most 100 projects a call", async () => {
    const names = Array.from({ length: 150 }, (_, i) => `build-${i}`);
    const batches: number[] = [];
    const ctx = runCase(CASES.find((c) => c.lister === listCodeBuildProjects)!).ctx;
    ctx.json = vi.fn(async (_service: string, target: string, body: Record<string, unknown>) => {
      if (target.endsWith(".ListProjects")) return { projects: names };
      const batch = body["names"] as string[];
      batches.push(batch.length);
      return { projects: batch.map((name) => ({ name })) };
    }) as ListerContext["json"];

    expect(await listCodeBuildProjects(ctx, "acct")).toHaveLength(150);
    expect(batches).toEqual([100, 50]);
  });
});

describe("collectPages", () => {
  it("stops when the service hands back the token it was given", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], next: "same" }));
    expect(await collectPages(fetchPage)).toEqual([1, 1]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("stops at the page cap and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const out = await collectPages(async () => ({ items: [n], next: `t${++n}` }), 3);
    expect(out).toEqual([0, 1, 2]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("treats null, empty and absent tokens as the end", async () => {
    for (const next of [null, "", undefined]) {
      const fetchPage = vi.fn(async () => ({ items: ["x"], next }));
      expect(await collectPages(fetchPage)).toEqual(["x"]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
  });
});

describe("queryString", () => {
  it("drops undefined values so the first page carries no token", () => {
    expect(queryString({ maxResults: 100, nextToken: undefined })).toBe("?maxResults=100");
    expect(queryString({ maxResults: 100, nextToken: "a/b=" })).toBe(
      "?maxResults=100&nextToken=a%2Fb%3D",
    );
    expect(queryString({})).toBe("");
  });
});

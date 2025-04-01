import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VOLUME_POLICY } from "./volume-policy";
import { Key } from "aws-cdk-lib/aws-kms";

interface RestateBYOCProps {
  vpc: cdk.aws_ec2.IVpc;
  subnets?: cdk.aws_ec2.SubnetSelection;
  objectStorage?: {
    bucket: cdk.aws_s3.IBucket;
    subpath?: string;
  };
  // Security groups to apply to the NLB, the restate nodes and the restatectl lambda.
  // If provided, internal connections on 8080, 9070 and 5122 are assumed to be allowed.
  // If not provided, a suitable group will be created.
  // To allow traffic through the NLB from clients outside the security group, additional inbound rules will be needed.
  securityGroups?: cdk.aws_ec2.ISecurityGroup[];
  loadBalancer?: RestateBYOCLoadBalancerProps;
  cluster?: cdk.aws_ecs.ICluster;
  statelessNode?: RestateBYOCStatelessProps;
  statefulNode?: RestateBYOCStatefulProps;
  restateTasks?: Partial<RestateBYOCTaskProps>;
  controller?: RestateBYOCControllerProps;
  restatectl?: RestateBYOCRestatectlProps;
  retirementWatcher?: RestateBYOCRetirementWatcherProps;
}

interface RestateBYOCLoadBalancerProps {
  nlb?: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
  listenerCertificates?: cdk.aws_elasticloadbalancingv2.IListenerCertificate[];
  sslPolicy?: cdk.aws_elasticloadbalancingv2.SslPolicy;
}

interface RestateBYOCStatelessProps extends RestateBYOCNodeProps {
  defaultLogReplication?: { node: number } | { zone: number };
  defaultPartitionReplication?: { node: number };
  defaultPartitions?: number;
  desiredCount?: number;
}

interface RestateBYOCStatefulProps extends RestateBYOCNodeProps {
  ebsVolume?: {
    enabled: true;
    volumeType?: cdk.aws_ec2.EbsDeviceVolumeType;
    volumeRole?: cdk.aws_iam.IRole;
    sizeInGiB: number;
    iops?: number;
    throughput?: number;
  };
}

interface RestateBYOCNodeProps {
  restateImage?: string;
  resources?: { cpu: number; memoryLimitMiB: number };
}

interface RestateBYOCControllerProps {
  resources?: { cpu: number; memoryLimitMiB: number };
  tasks?: RestateBYOCTaskProps;
}

interface RestateBYOCTaskProps {
  executionRole: cdk.aws_iam.IRole;
  taskRole: cdk.aws_iam.IRole;
  logDriver: cdk.aws_ecs.LogDriver;
  enableExecuteCommand: boolean;
  cpuArchitecture: cdk.aws_ecs.CpuArchitecture;
}

interface RestateBYOCRestatectlProps {
  disabled?: boolean;
}

interface RestateBYOCRetirementWatcherProps {
  executionRole?: cdk.aws_iam.IRole;
  disabled?: boolean;
}

const DEFAULT_RESTATE_IMAGE = "docker.restate.dev/restatedev/restate:1.3";

export class RestateBYOC extends Construct {
  public readonly vpc: cdk.aws_ec2.IVpc;
  public readonly bucket: cdk.aws_s3.IBucket;
  public readonly securityGroups: cdk.aws_ec2.ISecurityGroup[];
  public readonly stateless: {
    service: cdk.aws_ecs.IFargateService;
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  };
  public readonly statefulDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  public readonly loadBalancer: {
    nlb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
    ingress: {
      targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
      listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
    };
    admin: {
      targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
      listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
    };
    node: {
      targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
      listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
    };
  };
  public readonly cluster: cdk.aws_ecs.ICluster;
  public readonly restateTaskRole: cdk.aws_iam.IRole;
  public readonly restateExecutionRole: cdk.aws_iam.IRole;
  public readonly controller: {
    service: cdk.aws_ecs.IFargateService;
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  };
  public readonly restatectl?: cdk.aws_lambda.IFunction;
  public readonly retirementWatcher?: {
    fn: cdk.aws_lambda.IFunction;
    queue: cdk.aws_sqs.IQueue;
    rule: cdk.aws_events.IRule;
  };

  constructor(scope: Construct, id: string, props: RestateBYOCProps) {
    super(scope, id);

    this.vpc = props.vpc;

    const subnets = this.vpc.selectSubnets(
      props.subnets ?? {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true,
      },
    );

    if (
      (props.statelessNode?.defaultLogReplication &&
        "zone" in props.statelessNode.defaultLogReplication) ||
      props.statelessNode?.defaultLogReplication === undefined
    ) {
      const zoneReplication =
        props.statelessNode?.defaultLogReplication?.zone ?? 2;
      const zoneCount = new Set(subnets.availabilityZones).size;
      if (zoneCount <= zoneReplication) {
        throw new Error(
          `The selected subnets are spread over only ${zoneCount} zones, which is not enough to satisfy zone replication property ${zoneReplication}. It may be necessary to provide a particular region for your stack, so that all AZs can be used.`,
        );
      }
    }

    if (props.securityGroups?.length) {
      this.securityGroups = props.securityGroups;
    } else {
      const sg = new cdk.aws_ec2.SecurityGroup(this, "security-group", {
        vpc: this.vpc,
      });
      sg.connections.allowInternally(cdk.aws_ec2.Port.tcp(8080));
      sg.connections.allowInternally(cdk.aws_ec2.Port.tcp(9070));
      sg.connections.allowInternally(cdk.aws_ec2.Port.tcp(5122));
      cdk.Tags.of(sg).add("Name", sg.node.path);
      this.securityGroups = [sg];
    }

    if (props.objectStorage?.bucket) {
      this.bucket = props.objectStorage.bucket;
    } else {
      const bucket = new cdk.aws_s3.Bucket(this, "bucket", {
        blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: false,
      });
      this.bucket = bucket;
    }

    let bucketPath: `s3://${string}`;
    if (props.objectStorage?.subpath) {
      bucketPath = `s3://${this.bucket.bucketName}/${props.objectStorage.subpath}`;
    } else {
      bucketPath = `s3://${this.bucket.bucketName}`;
    }

    if (props.cluster) {
      this.cluster = props.cluster;
    } else {
      const cluster = new cdk.aws_ecs.Cluster(this, "cluster", {
        vpc: this.vpc,
        enableFargateCapacityProviders: true,
        containerInsightsV2: "enhanced", // this field may not exist in earlier cdk versions, hence 'as any'
      } as any);
      cdk.Tags.of(cluster).add("Name", cluster.node.path);
      this.cluster = cluster;
    }

    this.restateTaskRole =
      props.restateTasks?.taskRole ??
      new cdk.aws_iam.Role(this, "task-role", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      });

    this.restateExecutionRole =
      props.restateTasks?.executionRole ??
      new cdk.aws_iam.Role(this, "execution-role", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      });

    const restateTaskProps: RestateBYOCTaskProps = {
      taskRole: this.restateTaskRole,
      executionRole: this.restateExecutionRole,
      logDriver:
        props.restateTasks?.logDriver ??
        cdk.aws_ecs.LogDriver.awsLogs({
          streamPrefix: "restate",
        }),
      enableExecuteCommand: props.restateTasks?.enableExecuteCommand ?? false,
      cpuArchitecture:
        props.restateTasks?.cpuArchitecture ??
        cdk.aws_ecs.CpuArchitecture.ARM64,
    };

    const stateless = createStateless(
      this,
      bucketPath,
      this.cluster,
      this.securityGroups,
      subnets,
      restateTaskProps,
      props.statelessNode,
    );
    this.stateless = stateless;

    this.loadBalancer = createLoadBalancer(
      this,
      this.vpc,
      this.securityGroups,
      subnets,
      stateless.service,
      props.loadBalancer,
    );

    this.statefulDefinition = createStatefulDefinition(
      this,
      bucketPath,
      restateTaskProps,
      props.statefulNode,
    );

    const ctPrefix = clusterTaskPrefix(this.cluster.clusterArn);

    this.controller = createController(
      this,
      bucketPath,
      this.cluster,
      ctPrefix,
      subnets,
      this.securityGroups,
      this.statefulDefinition,
      props.statefulNode,
      props.controller,
    );

    this.restatectl = createRestatectl(
      this,
      this.vpc,
      subnets,
      this.securityGroups,
      this.loadBalancer.nlb,
      !!props.loadBalancer?.listenerCertificates?.length,
      props.restatectl,
    );

    this.retirementWatcher = createRetirementWatcher(
      scope,
      this.cluster,
      ctPrefix,
      props.retirementWatcher,
    );

    for (const bucketRole of [
      restateTaskProps.taskRole,
      this.controller.taskDefinition.taskRole,
    ]) {
      bucketRole.addToPrincipalPolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [`${this.bucket.bucketArn}/*`],
          effect: cdk.aws_iam.Effect.ALLOW,
          sid: "ReadWriteBucket",
        }),
      );

      bucketRole.addToPrincipalPolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [`${this.bucket.bucketArn}`],
          effect: cdk.aws_iam.Effect.ALLOW,
          sid: "ListBucket",
        }),
      );
    }
  }
}

function createStateless(
  scope: Construct,
  bucketPath: `s3://${string}`,
  cluster: cdk.aws_ecs.ICluster,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  taskProps: RestateBYOCTaskProps,
  statelessProps?: RestateBYOCStatelessProps,
): {
  service: cdk.aws_ecs.FargateService;
  taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
} {
  const cpu = statelessProps?.resources?.cpu ?? 16384;
  const memoryLimitMiB = statelessProps?.resources?.memoryLimitMiB ?? 32768;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "stateless-definition",
    {
      cpu,
      memoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture: taskProps.cpuArchitecture,
        operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: taskProps.taskRole,
      executionRole: taskProps.executionRole,
    },
  );
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  let logReplication = "{zone: 2}";
  if (statelessProps?.defaultLogReplication) {
    if ("zone" in statelessProps?.defaultLogReplication) {
      logReplication = `{zone: ${statelessProps?.defaultLogReplication.zone}}`;
    } else {
      logReplication = `{node: ${statelessProps?.defaultLogReplication.node}}`;
    }
  }

  taskDefinition.addContainer("restate", {
    cpu,
    memoryLimitMiB,
    image: cdk.aws_ecs.ContainerImage.fromRegistry(
      statelessProps?.restateImage ?? DEFAULT_RESTATE_IMAGE,
    ),
    portMappings: [
      {
        name: "ingress",
        containerPort: 8080,
      },
      {
        name: "admin",
        containerPort: 9070,
      },
      {
        name: "node",
        containerPort: 5122,
      },
    ],
    logging: taskProps.logDriver,
    stopTimeout: cdk.Duration.seconds(120), // the max
    healthCheck: {
      command: ["curl", "--fail", "http://127.0.0.1:8080/restate/health"],
    },
    environment: {
      RESTATE_LOG_FORMAT: "json",
      RESTATE_ROLES: '["admin","http-ingress"]',
      RESTATE_AUTO_PROVISION: "true",
      RESTATE_SHUTDOWN_TIMEOUT: "100s", // fargate allows 120s
      RESTATE_DEFAULT_NUM_PARTITIONS: `${statelessProps?.defaultPartitions ?? 128}`,

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",
      RESTATE_BIFROST__REPLICATED_LOGLET__DEFAULT_LOG_REPLICATION:
        logReplication,

      RESTATE_ADMIN__DEFAULT_PARTITION_REPLICATION__LIMIT: `{node: ${statelessProps?.defaultPartitionReplication?.node ?? 2}}`,

      RESTATE_INGRESS__EXPERIMENTAL_FEATURE_ENABLE_SEPARATE_INGRESS_ROLE:
        "true",

      // why? this isn't a worker! because the admin uses the presence of this flag as a signal of how to trim
      RESTATE_WORKER__SNAPSHOTS__DESTINATION: `${bucketPath}/snapshots`,
    },
  });

  const service = new cdk.aws_ecs.FargateService(scope, "stateless-service", {
    cluster,
    taskDefinition: taskDefinition,
    enableExecuteCommand: taskProps.enableExecuteCommand,
    vpcSubnets,
    securityGroups,
    desiredCount: statelessProps?.desiredCount ?? 3,
    maxHealthyPercent: 200,
    minHealthyPercent: 100,
    propagateTags: cdk.aws_ecs.PropagatedTagSource.SERVICE,
    capacityProviderStrategies: [
      {
        capacityProvider: "FARGATE",
        weight: 1,
      },
    ],
  });
  cdk.Tags.of(service).add("Name", service.node.path);

  return { service, taskDefinition };
}

function createStatefulDefinition(
  scope: Construct,
  bucketPath: `s3://${string}`,
  taskProps: RestateBYOCTaskProps,
  statefulProps?: RestateBYOCStatefulProps,
) {
  const cpu = statefulProps?.resources?.cpu ?? 16384;
  const memoryLimitMiB = statefulProps?.resources?.memoryLimitMiB ?? 32768;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "stateful-definition",
    {
      cpu,
      memoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture: taskProps.cpuArchitecture,
        operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
      },
      ephemeralStorageGiB: statefulProps?.ebsVolume?.enabled ? undefined : 200,
      volumes: [
        {
          name: "restate-data",
          configuredAtLaunch: statefulProps?.ebsVolume?.enabled,
        },
      ],
      taskRole: taskProps.taskRole,
      executionRole: taskProps.executionRole,
    },
  );
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  const restateContainer = taskDefinition.addContainer("restate", {
    cpu,
    memoryLimitMiB,
    image: cdk.aws_ecs.ContainerImage.fromRegistry(
      statefulProps?.restateImage ?? DEFAULT_RESTATE_IMAGE,
    ),
    portMappings: [
      {
        name: "node",
        containerPort: 5122,
      },
    ],
    healthCheck: {
      command: ["curl", "--fail", "http://127.0.0.1:5122/health"],
    },
    logging: taskProps.logDriver,
    stopTimeout: cdk.Duration.seconds(120), // the max
    enableRestartPolicy: true,
    restartAttemptPeriod: cdk.Duration.seconds(60),
    environment: {
      RESTATE_LOG_FORMAT: "json",
      RESTATE_ROLES: '["log-server", "worker", "http-ingress"]',
      RESTATE_AUTO_PROVISION: "false",
      RESTATE_SHUTDOWN_TIMEOUT: "100s", // fargate allows 120s

      RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: `${Math.round(memoryLimitMiB * 0.75)}MiB`,

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_WORKER__SNAPSHOTS__DESTINATION: `${bucketPath}/snapshots`,
      RESTATE_WORKER__SNAPSHOTS__SNAPSHOT_INTERVAL_NUM_RECORDS: "1000000",

      RESTATE_WORKER__STORAGE__ROCKSDB_DISABLE_DIRECT_IO_FOR_READS: "true",
      RESTATE_WORKER__STORAGE__ROCKSDB_DISABLE_WAL_FSYNC: "true",

      RESTATE_LOG_SERVER__ROCKSDB_DISABLE_WAL_FSYNC: "true",
      RESTATE_LOG_SERVER__ROCKSDB_DISABLE_DIRECT_IO_FOR_READS: "true",

      RESTATE_INGRESS__EXPERIMENTAL_FEATURE_ENABLE_SEPARATE_INGRESS_ROLE:
        "true",
    },
  });

  restateContainer.addMountPoints({
    sourceVolume: "restate-data",
    containerPath: "/restate-data",
    readOnly: false,
  });

  return taskDefinition;
}

function createLoadBalancer(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  statelessService: cdk.aws_ecs.FargateService,
  props?: RestateBYOCLoadBalancerProps,
): {
  nlb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
  ingress: {
    targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
  };
  admin: {
    targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
  };
  node: {
    targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    listener: cdk.aws_elasticloadbalancingv2.INetworkListener;
  };
} {
  let nlb;
  if (props?.nlb) {
    nlb = props?.nlb;
  } else {
    nlb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(scope, "nlb", {
      vpc,
      securityGroups,
      vpcSubnets,
      internetFacing: false,
      clientRoutingPolicy:
        cdk.aws_elasticloadbalancingv2.ClientRoutingPolicy
          .AVAILABILITY_ZONE_AFFINITY,
      crossZoneEnabled: false,
    });
    cdk.Tags.of(nlb).add("Name", nlb.node.path);
  }

  const ingressTargetGroup =
    new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(
      scope,
      "ingress-target",
      {
        vpc,
        deregistrationDelay: cdk.Duration.seconds(10), // todo remove
        healthCheck: {
          enabled: true,
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          path: "/restate/health",
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        },
        targets: [
          statelessService.loadBalancerTarget({
            containerName: "restate",
            containerPort: 8080,
          }),
        ],
        port: 8080,
      },
    );
  cdk.Tags.of(ingressTargetGroup).add("Name", ingressTargetGroup.node.path);

  const ingressListener = nlb.addListener("ingress-listener", {
    port: props?.listenerCertificates?.length ? 443 : 8080,
    defaultTargetGroups: [ingressTargetGroup],
    certificates: props?.listenerCertificates,
    sslPolicy: props?.sslPolicy,
    alpnPolicy: props?.listenerCertificates?.length
      ? cdk.aws_elasticloadbalancingv2.AlpnPolicy.HTTP2_PREFERRED
      : undefined,
  });
  cdk.Tags.of(ingressListener).add("Name", ingressListener.node.path);

  const adminTargetGroup =
    new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(
      scope,
      "admin-target",
      {
        vpc,
        deregistrationDelay: cdk.Duration.seconds(10), // todo remove
        healthCheck: {
          enabled: true,
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          path: "/health",
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
          port: "9070",
        },
        targets: [
          statelessService.loadBalancerTarget({
            containerName: "restate",
            containerPort: 9070,
          }),
        ],
        port: 9070,
      },
    );
  cdk.Tags.of(adminTargetGroup).add("Name", adminTargetGroup.node.path);

  const adminListener = nlb.addListener("admin-listener", {
    port: 9070,
    defaultTargetGroups: [adminTargetGroup],
    certificates: props?.listenerCertificates,
    sslPolicy: props?.sslPolicy,
    alpnPolicy: props?.listenerCertificates?.length
      ? cdk.aws_elasticloadbalancingv2.AlpnPolicy.HTTP2_PREFERRED
      : undefined,
  });
  cdk.Tags.of(adminListener).add("Name", adminListener.node.path);

  const nodeTargetGroup = new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(
    scope,
    "node-target",
    {
      vpc,
      deregistrationDelay: cdk.Duration.seconds(10), // todo remove
      targetGroupName: "restate-bluegreen-node",
      healthCheck: {
        enabled: true,
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        path: "/health",
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        port: "5122",
      },
      targets: [
        statelessService.loadBalancerTarget({
          containerName: "restate",
          containerPort: 5122,
        }),
      ],
      port: 5122,
    },
  );
  cdk.Tags.of(nodeTargetGroup).add("Name", nodeTargetGroup.node.path);

  const nodeListener = nlb.addListener("node-listener", {
    port: 5122,
    defaultTargetGroups: [nodeTargetGroup],
    certificates: props?.listenerCertificates,
    sslPolicy: props?.sslPolicy,
    alpnPolicy: props?.listenerCertificates?.length
      ? cdk.aws_elasticloadbalancingv2.AlpnPolicy.HTTP2_PREFERRED
      : undefined,
  });
  cdk.Tags.of(nodeListener).add("Name", nodeListener.node.path);

  return {
    nlb,
    ingress: {
      targetGroup: ingressTargetGroup,
      listener: ingressListener,
    },
    admin: {
      targetGroup: adminTargetGroup,
      listener: adminListener,
    },
    node: {
      targetGroup: nodeTargetGroup,
      listener: nodeListener,
    },
  };
}

function createController(
  scope: Construct,
  bucketPath: `s3://${string}`,
  cluster: cdk.aws_ecs.ICluster,
  clusterTaskPrefix: string,
  vpcSubnets: cdk.aws_ec2.SelectedSubnets,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  statefulDefinition: cdk.aws_ecs.IFargateTaskDefinition,
  statefulProps?: RestateBYOCStatefulProps,
  controllerProps?: RestateBYOCControllerProps,
): {
  service: cdk.aws_ecs.IFargateService;
  taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
} {
  const cpu = controllerProps?.resources?.cpu ?? 1024;
  const memoryLimitMiB = controllerProps?.resources?.memoryLimitMiB ?? 2048;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "controller-definition",
    {
      cpu,
      memoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture:
          controllerProps?.tasks?.cpuArchitecture ??
          cdk.aws_ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
      },
      executionRole: controllerProps?.tasks?.executionRole,
      taskRole: controllerProps?.tasks?.taskRole,
    },
  );
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  let volumeRole: cdk.aws_iam.IRole | undefined;
  if (statefulProps?.ebsVolume?.enabled) {
    if (statefulProps.ebsVolume.volumeRole) {
      volumeRole = statefulProps.ebsVolume.volumeRole;
    } else {
      volumeRole = new cdk.aws_iam.Role(scope, "volume-role", {
        inlinePolicies: { volume: VOLUME_POLICY },
        assumedBy:
          cdk.aws_iam.ServicePrincipal.fromStaticServicePrincipleName(
            "ecs.amazonaws.com",
          ),
      });
      cdk.Tags.of(volumeRole).add("Name", volumeRole.node.path);
    }
  }

  const zoneEnvs = vpcSubnets.subnets
    .map(({ availabilityZone, subnetId }) => {
      let zoneConfig: { [k: string]: string } = {};

      const set = (parts: string[], value?: string | number) => {
        if (value === undefined) return;

        zoneConfig = {
          [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__ZONES__${availabilityZone}__${parts.join("__")}`]: `${value}`,
          ...zoneConfig,
        };
      };

      set(["TASK_DEFINITION_ARN"], statefulDefinition.taskDefinitionArn);
      set(["SUBNETS"], `["${subnetId}"]`);
      set(
        ["SECURITY_GROUPS"],
        `[${securityGroups.map(({ securityGroupId }) => `"${securityGroupId}"`).join(",")}]`,
      );
      set(
        ["ENABLE_EXECUTE_COMMAND"],
        `${!!controllerProps?.tasks?.enableExecuteCommand}`,
      );

      if (statefulProps?.ebsVolume?.enabled) {
        set(["VOLUME", "NAME"], "restate-data");
        set(["VOLUME", `VOLUME_TYPE`], statefulProps.ebsVolume.volumeType);
        set(["VOLUME", `ROLE_ARN`], volumeRole?.roleArn);
        set(["VOLUME", `SIZE_IN_GIB`], statefulProps.ebsVolume.sizeInGiB);
        set(["VOLUME", `IOPS`], statefulProps.ebsVolume.iops);
        set(["VOLUME", `THROUGHPUT`], statefulProps.ebsVolume.throughput);
      }

      return zoneConfig;
    })
    .reduce((prev, curr) => ({ ...prev, ...curr }));

  const config = {
    CONTROLLER_LOG_FORMAT: "json",
    CONTROLLER_METADATA_PATH: `${bucketPath}/metadata`,
    CONTROLLER_RECONCILE_INTERVAL: "10s",
    CONTROLLER_CLUSTER__CLUSTER_ARN: cluster.clusterArn,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__REGION`]: cdk.Aws.REGION,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__CLUSTER_ARN`]:
      cluster.clusterArn,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__TASK_PREFIX`]:
      clusterTaskPrefix,
    ...zoneEnvs,
  };

  taskDefinition.addContainer("controller", {
    cpu,
    memoryLimitMiB,
    image: cdk.aws_ecs.ContainerImage.fromTarball(".cache/controller.tar"),
    logging:
      controllerProps?.tasks?.logDriver ??
      cdk.aws_ecs.LogDriver.awsLogs({
        streamPrefix: "controller",
      }),
    stopTimeout: cdk.Duration.seconds(120), // the max
    healthCheck: {
      command: ["curl", "--fail", "http://127.0.0.1:8080/health"],
      interval: cdk.Duration.seconds(30),
      retries: 10, // must not reconcile for 300s to be considered unhealthy
      startPeriod: cdk.Duration.seconds(300), // give controllers an extra 300s after startup
    },
    environment: {
      RUST_LOG: "info,restate_fargate_controller=debug",
      ...config,
    },
  });

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:ListTasks", "ecs:DescribeTasks", "ecs:StopTask"],
      resources: ["*"],
      conditions: {
        ArnEquals: { "ecs:cluster": cluster.clusterArn },
      },
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "TaskActions",
    }),
  );

  const unversionedStatefulTaskDefinition =
    // task definition arns have 7 components in between ':', the last being a version. we want to use the first 6 only.
    `${cdk.Fn.join(
      ":",
      cdk.Fn.split(":", statefulDefinition.taskDefinitionArn, 7).slice(0, 6),
    )}:*`;

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: ["*"],
      conditions: {
        ArnEquals: {
          "ecs:cluster": cluster.clusterArn,
        },
        ArnLike: {
          "ecs:task-definition": unversionedStatefulTaskDefinition,
        },
      },
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "RunTask",
    }),
  );

  const passTaskRoles: cdk.aws_iam.IRole[] = [statefulDefinition.taskRole];
  if (statefulDefinition.executionRole)
    passTaskRoles.push(statefulDefinition.executionRole);

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: passTaskRoles.map((role) => role.roleArn),
      conditions: {
        StringEquals: {
          "iam:PassedToService": "ecs-tasks.amazonaws.com",
        },
      },
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "RunTaskPassRole",
    }),
  );

  if (volumeRole) {
    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [volumeRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ecs.amazonaws.com",
          },
        },
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "RunTaskPassVolumeRole",
      }),
    );
  }

  const service = new cdk.aws_ecs.FargateService(scope, "controller-service", {
    cluster,
    taskDefinition,
    enableExecuteCommand: controllerProps?.tasks?.enableExecuteCommand,
    securityGroups,
    desiredCount: 1,
    // its ok for no controllers to be running sometimes, but we'd like to avoid two where we can.
    maxHealthyPercent: 100,
    minHealthyPercent: 0,
    capacityProviderStrategies: [
      {
        capacityProvider: "FARGATE",
        weight: 1,
      },
    ],
    vpcSubnets,
  });
  cdk.Tags.of(service).add("Name", service.node.path);

  return { service, taskDefinition };
}

function createRetirementWatcher(
  scope: Construct,
  cluster: cdk.aws_ecs.ICluster,
  clusterTaskPrefix: string,
  retirementWatcherProps?: RestateBYOCRetirementWatcherProps,
):
  | {
      fn: cdk.aws_lambda.IFunction;
      queue: cdk.aws_sqs.IQueue;
      rule: cdk.aws_events.IRule;
    }
  | undefined {
  if (retirementWatcherProps?.disabled) return;

  const fn = new cdk.aws_lambda.Function(scope, "retirement-watcher-lambda", {
    role: retirementWatcherProps?.executionRole,
    runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: cdk.aws_lambda.Code.fromAsset("lib/lambda/retirement-watcher"),
    environment: {
      CLUSTER_ARN: cluster.clusterArn,
      NODE_OPTIONS: "--experimental-strip-types", // so that we can import a .ts file
    },
    timeout: cdk.Duration.seconds(60),
  });
  cdk.Tags.of(fn).add("Name", fn.node.path);

  fn.grantPrincipal.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:DescribeClusters", "ecs:TagResource"],
      resources: [cluster.clusterArn],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "ClusterActions",
    }),
  );

  // We use SQS so that we get infinite retries - if we go straight to lambda from eventbridge you only
  // get two retries. We could have a dead letter here and then alert when events go into it.
  const queue = new cdk.aws_sqs.Queue(scope, "retirement-watcher-queue", {
    visibilityTimeout: cdk.Duration.seconds(60),
  });
  cdk.Tags.of(queue).add("Name", queue.node.path);

  fn.addEventSource(
    new cdk.aws_lambda_event_sources.SqsEventSource(queue, {
      batchSize: 1,
    }),
  );

  const rule = new cdk.aws_events.Rule(scope, "retirement-watcher-rule", {
    eventPattern: {
      detail: {
        eventTypeCode: cdk.aws_events.Match.equalsIgnoreCase(
          "AWS_ECS_TASK_PATCHING_RETIREMENT",
        ),
        service: cdk.aws_events.Match.equalsIgnoreCase("ecs"),
      },
      resources: cdk.aws_events.Match.prefix(clusterTaskPrefix),
      detailType: cdk.aws_events.Match.equalsIgnoreCase("AWS Health Event"),
    },
    targets: [new cdk.aws_events_targets.SqsQueue(queue)],
  });
  cdk.Tags.of(rule).add("Name", rule.node.path);

  return { fn, queue, rule };
}

function clusterTaskPrefix(clusterArn: string): string {
  // arn:aws:ecs:eu-central-1:211125428070:cluster/cluster-name
  const clusterSlashParts = cdk.Fn.split("/", clusterArn, 2);
  // ["arn:aws:ecs:eu-central-1:211125428070:cluster", "cluster-name"]
  const clusterColonParts = cdk.Fn.split(":", clusterSlashParts[0], 6);
  // ["arn","aws","ecs","eu-central-1","211125428070","task"]
  const clusterTaskPrefixBeforeSlash = cdk.Fn.join(
    ":",
    clusterColonParts.slice(0, 5).concat(["task"]),
  );
  // ["arn:aws:ecs:eu-central-1:211125428070:task","cluster-name",""]
  const clusterTaskPrefix = cdk.Fn.join("/", [
    clusterTaskPrefixBeforeSlash,
    clusterSlashParts[1],
    "",
  ]);
  // arn:aws:ecs:eu-central-1:211125428070:task/cluster-name/
  return clusterTaskPrefix;
}

function createRestatectl(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  vpcSubnets: cdk.aws_ec2.SelectedSubnets,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  nlb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer,
  ssl: boolean,
  restatectlProps?: RestateBYOCRestatectlProps,
): cdk.aws_lambda.Function | undefined {
  if (restatectlProps?.disabled) return;

  const address = `${ssl ? "https" : "http"}://${nlb.loadBalancerDnsName}:5122`;

  const fn = new cdk.aws_lambda.Function(scope, "restatectl-lambda", {
    runtime: cdk.aws_lambda.Runtime.PROVIDED_AL2023,
    handler: "restatectl", // irrelevant
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    code: cdk.aws_lambda.Code.fromCustomCommand(".cache/restatectl/lambda", [
      "bash",
      "./scripts/download-restatectl.sh",
      "https://restate.gateway.scarf.sh/v1.3.0-rc.1/restatectl-aarch64-unknown-linux-musl.tar.xz",
    ]),
    environment: {
      RESTATECTL_ADDRESS: address,
    },
    vpc,
    vpcSubnets,
    securityGroups,
    timeout: cdk.Duration.seconds(10),
  });
  cdk.Tags.of(fn).add("Name", fn.node.path);

  return fn;
}

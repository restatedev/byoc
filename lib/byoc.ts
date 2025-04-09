import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VOLUME_POLICY } from "./volume-policy";
import {
  DEFAULT_CONTROLLER_CPU,
  DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB,
  DEFAULT_RESTATE_CPU,
  DEFAULT_RESTATE_IMAGE,
  DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
  DEFAULT_STATEFUL_NODES_PER_AZ,
  DEFAULT_STATELESS_DESIRED_COUNT,
  RestateBYOCControllerProps,
  RestateBYOCLoadBalancerProps,
  RestateBYOCProps,
  RestateBYOCRestatectlProps,
  RestateBYOCRetirementWatcherProps,
  RestateBYOCStatefulProps,
  RestateBYOCStatelessProps,
  RestateBYOCTaskProps,
} from "./props";
import { createMonitoring } from "./monitoring";

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
  public readonly monitoring: {
    metricsDashboard?: cdk.aws_cloudwatch.Dashboard;
    controlPanelDashboard?: cdk.aws_cloudwatch.Dashboard;
    customWidgetFn?: cdk.aws_lambda.IFunction;
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
      new cdk.aws_iam.Role(this, "restate-task-role", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      });

    this.restateExecutionRole =
      props.restateTasks?.executionRole ??
      new cdk.aws_iam.Role(this, "restate-execution-role", {
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

    const statefulDefinition = createStatefulDefinition(
      this,
      bucketPath,
      restateTaskProps,
      props.statefulNode,
    );
    this.statefulDefinition = statefulDefinition;

    const ctPrefix = clusterTaskPrefix(this.cluster.clusterArn);

    const controller = createController(
      this,
      bucketPath,
      this.cluster,
      ctPrefix,
      subnets,
      this.securityGroups,
      this.statefulDefinition,
      restateTaskProps,
      props.statefulNode,
      props.controller,
    );
    this.controller = controller;

    this.restatectl = createRestatectl(
      this,
      this.vpc,
      subnets,
      this.securityGroups,
      this.loadBalancer.nlb,
      props.loadBalancer?.ssl?.listenerCertificate !== undefined,
      props.restatectl,
    );

    this.retirementWatcher = createRetirementWatcher(
      this,
      this.cluster,
      ctPrefix,
      props.retirementWatcher,
    );

    const monitoring = createMonitoring(
      this,
      this.cluster,
      stateless.taskDefinition,
      statefulDefinition,
      controller.taskDefinition,
      this.restatectl,
      props,
    );
    if (monitoring) this.monitoring = monitoring;

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
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition;
} {
  const cpu = statelessProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const memoryLimitMiB =
    statelessProps?.resources?.memoryLimitMiB ??
    DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

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
    entryPoint: ["bash", "-c", restateEntryPointScript],
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
      RESTATE_DEFAULT_REPLICATION: `{node: ${statelessProps?.defaultPartitionReplication?.node ?? 3} }`,

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",
      RESTATE_BIFROST__REPLICATED_LOGLET__DEFAULT_LOG_REPLICATION:
        logReplication,

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
    desiredCount:
      statelessProps?.desiredCount ?? DEFAULT_STATELESS_DESIRED_COUNT,
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
  const cpu = statefulProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const memoryLimitMiB =
    statefulProps?.resources?.memoryLimitMiB ??
    DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

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
      ephemeralStorageGiB: statefulProps?.ebsVolume ? undefined : 200,
      volumes: [
        {
          name: "restate-data",
          configuredAtLaunch: statefulProps?.ebsVolume ? true : false,
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
    entryPoint: ["bash", "-c", restateEntryPointScript],
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
      RESTATE_ROLES: '["log-server", "worker"]',
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
    port: props?.ssl?.listenerCertificate ? 443 : 8080,
    defaultTargetGroups: [ingressTargetGroup],
    certificates: props?.ssl?.listenerCertificate
      ? [props.ssl.listenerCertificate]
      : undefined,
    sslPolicy: props?.ssl?.sslPolicy,
    alpnPolicy: props?.ssl?.listenerCertificate
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
    certificates: props?.ssl?.listenerCertificate
      ? [props.ssl.listenerCertificate]
      : undefined,
    sslPolicy: props?.ssl?.sslPolicy,
    alpnPolicy: props?.ssl?.listenerCertificate
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
    certificates: props?.ssl?.listenerCertificate
      ? [props.ssl.listenerCertificate]
      : undefined,
    sslPolicy: props?.ssl?.sslPolicy,
    alpnPolicy: props?.ssl?.listenerCertificate
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
  restateTaskProps: RestateBYOCTaskProps,
  statefulProps?: RestateBYOCStatefulProps,
  controllerProps?: RestateBYOCControllerProps,
): {
  service: cdk.aws_ecs.IFargateService;
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition;
} {
  const taskRole =
    controllerProps?.tasks?.taskRole ??
    new cdk.aws_iam.Role(scope, "controller-task-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

  const executionRole =
    controllerProps?.tasks?.executionRole ??
    new cdk.aws_iam.Role(scope, "controller-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

  const controllerTaskProps = {
    taskRole,
    executionRole,
    logDriver:
      controllerProps?.tasks?.logDriver ??
      cdk.aws_ecs.LogDriver.awsLogs({
        streamPrefix: "controller",
      }),
    enableExecuteCommand: controllerProps?.tasks?.enableExecuteCommand ?? false,
    cpuArchitecture:
      controllerProps?.tasks?.cpuArchitecture ??
      cdk.aws_ecs.CpuArchitecture.ARM64,
  };

  const cpu = controllerProps?.resources?.cpu ?? DEFAULT_CONTROLLER_CPU;
  const memoryLimitMiB =
    controllerProps?.resources?.memoryLimitMiB ??
    DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "controller-definition",
    {
      cpu,
      memoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture: controllerTaskProps.cpuArchitecture,
        operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
      },
      executionRole: controllerTaskProps.executionRole,
      taskRole: controllerTaskProps.taskRole,
    },
  );
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  let volumeRole: cdk.aws_iam.IRole | undefined;
  if (statefulProps?.ebsVolume) {
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

      set(
        ["COUNT"],
        statefulProps?.nodesPerAz ?? DEFAULT_STATEFUL_NODES_PER_AZ,
      );
      set(["TASK_DEFINITION_ARN"], statefulDefinition.taskDefinitionArn);
      set(["SUBNETS"], `["${subnetId}"]`);
      set(
        ["SECURITY_GROUPS"],
        `[${securityGroups.map(({ securityGroupId }) => `"${securityGroupId}"`).join(",")}]`,
      );
      set(
        ["ENABLE_EXECUTE_COMMAND"],
        `${restateTaskProps.enableExecuteCommand}`,
      );

      if (statefulProps?.ebsVolume) {
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
    image: cdk.aws_ecs.ContainerImage.fromTarball(
      controllerProps?.controllerImageTarball ?? "controller.tar",
    ),
    logging: controllerTaskProps.logDriver,
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

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:TagResource"],
      resources: [`${clusterTaskPrefix}*`],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "TagTasks",
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
      resources: [unversionedStatefulTaskDefinition],
      conditions: {
        ArnEquals: {
          "ecs:cluster": cluster.clusterArn,
        },
      },
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "RunTask",
    }),
  );

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [
        restateTaskProps.taskRole.roleArn,
        restateTaskProps.executionRole.roleArn,
      ],
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
    enableExecuteCommand: controllerTaskProps.enableExecuteCommand,
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

  const role =
    retirementWatcherProps?.executionRole ??
    new cdk.aws_iam.Role(scope, "retirement-watcher-lambda-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaBasicExecutionPermissions",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:TagResource"],
      resources: [`${clusterTaskPrefix}*`],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "TagTasks",
    }),
  );

  const fn = new cdk.aws_lambda.Function(scope, "retirement-watcher-lambda", {
    role,
    runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: cdk.aws_lambda.Code.fromAsset(
      `${__dirname}/lambda/retirement-watcher`,
    ),
    timeout: cdk.Duration.seconds(60),
  });
  cdk.Tags.of(fn).add("Name", fn.node.path);

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

  const role =
    restatectlProps?.executionRole ??
    new cdk.aws_iam.Role(scope, "restatectl-lambda-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
      ],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaVPCAccessExecutionPermissions",
    }),
  );

  const fn = new cdk.aws_lambda.Function(scope, "restatectl-lambda", {
    role,
    runtime: cdk.aws_lambda.Runtime.PROVIDED_AL2023,
    handler: "restatectl", // irrelevant
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    code: cdk.aws_lambda.Code.fromAsset(`${__dirname}/lambda/restatectl`),
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

const restateEntryPointScript = String.raw`
curl --no-progress-meter $ECS_CONTAINER_METADATA_URI_V4/task -o task-metadata && \
export \
  RESTATE_CLUSTER_NAME=$(jq -r '.Cluster' task-metadata) \
  RESTATE_NODE_NAME=$(jq -r '.TaskARN' task-metadata) \
  RESTATE_LOCATION="$AWS_REGION.$(jq -r '.AvailabilityZone' task-metadata)" \
  RESTATE_ADVERTISED_ADDRESS="http://$(jq -r '.Containers[0].Networks[0].IPv4Addresses[0]' task-metadata):5122"
exec restate-server
`;

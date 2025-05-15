import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VOLUME_POLICY } from "./volume-policy";
import {
  assertSupportedRestateVersion,
  CreateActions,
  DEFAULT_ALB_CREATE_ACTION,
  DEFAULT_CONTROLLER_CPU,
  DEFAULT_CONTROLLER_IMAGE,
  DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB,
  DEFAULT_RESTATE_CPU,
  DEFAULT_RESTATE_IMAGE,
  DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
  DEFAULT_STATEFUL_NODES_PER_AZ,
  DEFAULT_STATELESS_DESIRED_COUNT,
  ListenerSource,
  RestateBYOCControllerProps,
  RestateBYOCLoadBalancerProps,
  RestateBYOCNodeProps,
  RestateBYOCProps,
  RestateBYOCRestatectlProps,
  RestateBYOCRetirementWatcherProps,
  RestateBYOCStatefulProps,
  RestateBYOCStatelessProps,
  RestateBYOCTaskProps,
  SupportedRestateVersion,
} from "./props";
import { createMonitoring } from "./monitoring";

export class RestateBYOC extends Construct implements cdk.aws_ec2.IConnectable, cdk.aws_iam.IGrantable {
  public readonly clusterName: string;
  public readonly vpc: cdk.aws_ec2.IVpc;
  public readonly bucket: cdk.aws_s3.IBucket;
  public readonly securityGroups: cdk.aws_ec2.ISecurityGroup[];
  public readonly stateless: {
    service: cdk.aws_ecs.IFargateService;
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  };
  public readonly statefulDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  public readonly loadBalancer: {
    ingress: TargetGroup & Listener;
    admin: TargetGroup & Listener;
    node: TargetGroup & Listener;
  };
  public readonly ecsCluster: cdk.aws_ecs.ICluster;
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
  readonly connections: cdk.aws_ec2.Connections;
  readonly grantPrincipal: cdk.aws_iam.IPrincipal;

  constructor(scope: Construct, id: string, props: RestateBYOCProps) {
    super(scope, id);

    if (!props.vpc) throw new Error("A vpc must be provided");
    if (!props.licenseID) throw new Error("A license ID must be provided");

    this.clusterName = props.clusterName ?? this.node.path;

    this.vpc = props.vpc;

    const subnets = this.vpc.selectSubnets(
      props.subnets ?? {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true,
      },
    );

    if (
      (props.statelessNode?.defaultReplication && "zone" in props.statelessNode.defaultReplication) ||
      props.statelessNode?.defaultReplication === undefined
    ) {
      const zoneReplication = props.statelessNode?.defaultReplication?.zone ?? 2;
      const zoneCount = new Set(subnets.availabilityZones).size;
      if (zoneCount <= zoneReplication) {
        throw new Error(
          `The selected subnets are spread over only ${zoneCount} zones, which is not enough to satisfy zone replication property ${zoneReplication}. It may be necessary to provide a particular region for your stack, so that all AZs can be used.`,
        );
      }
    }

    const statelessRestateVersion = validateRestateVersion(props.statelessNode);
    validateRestateVersion(props.statefulNode);

    if (props.securityGroups?.length) {
      this.securityGroups = props.securityGroups;
      this.connections = new cdk.aws_ec2.Connections({
        securityGroups: props.securityGroups,
      });
    } else {
      const sg = new cdk.aws_ec2.SecurityGroup(this, "security-group", {
        vpc: this.vpc,
      });
      sg.addIngressRule(sg, cdk.aws_ec2.Port.tcp(8080));
      sg.addIngressRule(sg, cdk.aws_ec2.Port.tcp(9070));
      sg.addIngressRule(sg, cdk.aws_ec2.Port.tcp(5122));
      cdk.Tags.of(sg).add("Name", sg.node.path);
      this.securityGroups = [sg];
      this.connections = new cdk.aws_ec2.Connections({
        securityGroups: [sg],
      });
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

    if (props.ecsCluster) {
      this.ecsCluster = props.ecsCluster;
    } else {
      const cluster = new cdk.aws_ecs.Cluster(this, "cluster", {
        vpc: this.vpc,
        enableFargateCapacityProviders: true,
        containerInsightsV2: cdk.aws_ecs.ContainerInsights.ENHANCED,
      });
      cdk.Tags.of(cluster).add("Name", cluster.node.path);
      this.ecsCluster = cluster;
    }

    this.restateTaskRole =
      props.restateTasks?.taskRole ??
      new cdk.aws_iam.Role(this, "restate-task-role", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      });
    this.grantPrincipal = this.restateTaskRole;

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
      cpuArchitecture: props.restateTasks?.cpuArchitecture ?? cdk.aws_ecs.CpuArchitecture.ARM64,
    };

    const listeners = createListeners(this, this.vpc, this.securityGroups, subnets, props.loadBalancer);

    const ingressAdvertisedAddress = `${listeners.ingress.protocol}://${listeners.ingress.lb.loadBalancerDnsName}:${listeners.ingress.port}`;

    const stateless = createStateless(
      this,
      this.clusterName,
      bucketPath,
      this.ecsCluster,
      this.securityGroups,
      subnets,
      restateTaskProps,
      ingressAdvertisedAddress,
      props.statelessNode,
    );
    this.stateless = stateless;

    const statefulDefinition = createStatefulDefinition(
      this,
      this.clusterName,
      bucketPath,
      restateTaskProps,
      props.statefulNode,
    );
    this.statefulDefinition = statefulDefinition;

    const loadBalancer = createTargetGroups(this, this.vpc, listeners, stateless.service);
    this.loadBalancer = loadBalancer;

    const ctPrefix = clusterTaskPrefix(this.ecsCluster.clusterArn);

    const controller = createController(
      this,
      props.licenseID,
      bucketPath,
      this.ecsCluster,
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
      `${loadBalancer.node.protocol}://${loadBalancer.node.lb.loadBalancerDnsName}:${loadBalancer.node.port}`,
      props.restatectl,
    );

    this.retirementWatcher = createRetirementWatcher(this, this.ecsCluster, ctPrefix, props.retirementWatcher);

    const monitoring = createMonitoring(
      this,
      this.clusterName,
      this.vpc,
      subnets,
      this.securityGroups,
      this.bucket,
      this.ecsCluster,
      stateless.service,
      stateless.taskDefinition,
      statelessRestateVersion,
      statefulDefinition,
      controller.service,
      controller.taskDefinition,
      {
        ingress: {
          loadBalancerArn: loadBalancer.ingress.lb.loadBalancerArn,
          certificateArn: loadBalancer.ingress.certificate?.certificateArn,
          address: ingressAdvertisedAddress,
        },
        admin: {
          loadBalancerArn: loadBalancer.admin.lb.loadBalancerArn,
          address: `${loadBalancer.admin.protocol}://${loadBalancer.admin.lb.loadBalancerDnsName}:${loadBalancer.admin.port}`,
        },
        webUI: {
          address: `${loadBalancer.admin.protocol}://${loadBalancer.admin.lb.loadBalancerDnsName}:${loadBalancer.admin.port}/ui`,
        },
      },
      this.restatectl,
      props,
    );
    if (monitoring) this.monitoring = monitoring;

    for (const bucketRole of [restateTaskProps.taskRole, this.controller.taskDefinition.taskRole]) {
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
  clusterName: string,
  bucketPath: `s3://${string}`,
  cluster: cdk.aws_ecs.ICluster,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  taskProps: RestateBYOCTaskProps,
  ingressAdvertisedAddress: string,
  statelessProps?: RestateBYOCStatelessProps,
): {
  service: cdk.aws_ecs.FargateService;
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition;
} {
  const cpu = statelessProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const memoryLimitMiB = statelessProps?.resources?.memoryLimitMiB ?? DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(scope, "stateless-definition", {
    cpu,
    memoryLimitMiB,
    runtimePlatform: {
      cpuArchitecture: taskProps.cpuArchitecture,
      operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
    },
    taskRole: taskProps.taskRole,
    executionRole: taskProps.executionRole,
  });
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  let replication = "{zone: 2}";
  if (statelessProps?.defaultReplication) {
    if ("zone" in statelessProps.defaultReplication) {
      replication = `{zone: ${statelessProps?.defaultReplication.zone}}`;
    } else {
      replication = `{node: ${statelessProps?.defaultReplication.node}}`;
    }
  }

  taskDefinition.addContainer("restate", {
    cpu,
    memoryLimitMiB,
    entryPoint: ["bash", "-c", restateEntryPointScript],
    image:
      statelessProps?.overrideRestateImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(statelessProps?.restateImage ?? DEFAULT_RESTATE_IMAGE),
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
      RUST_BACKTRACE: "full",
      RESTATE_LOG_FORMAT: "json",
      RESTATE_CLUSTER_NAME: clusterName,
      RESTATE_ROLES: '["admin","http-ingress"]',
      RESTATE_AUTO_PROVISION: "true",
      RESTATE_SHUTDOWN_TIMEOUT: "100s", // fargate allows 120s
      RESTATE_DEFAULT_NUM_PARTITIONS: `${statelessProps?.defaultPartitions ?? 128}`,
      RESTATE_DEFAULT_REPLICATION: replication,

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",

      RESTATE_INGRESS__EXPERIMENTAL_FEATURE_ENABLE_SEPARATE_INGRESS_ROLE: "true",
      RESTATE_INGRESS__ADVERTISED_INGRESS_ENDPOINT:
        statelessProps?.ingressAdvertisedAddress ?? ingressAdvertisedAddress,

      // why? this isn't a worker! because the admin uses the presence of this flag as a signal of how to trim
      RESTATE_WORKER__SNAPSHOTS__DESTINATION: `${bucketPath}/snapshots`,

      // ...statelessProps?.environment,
    },
  });

  const service = new cdk.aws_ecs.FargateService(scope, "stateless-service", {
    cluster,
    taskDefinition: taskDefinition,
    enableExecuteCommand: taskProps.enableExecuteCommand,
    vpcSubnets,
    securityGroups,
    desiredCount: statelessProps?.desiredCount ?? DEFAULT_STATELESS_DESIRED_COUNT,
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
  clusterName: string,
  bucketPath: `s3://${string}`,
  taskProps: RestateBYOCTaskProps,
  statefulProps?: RestateBYOCStatefulProps,
) {
  const cpu = statefulProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const memoryLimitMiB = statefulProps?.resources?.memoryLimitMiB ?? DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(scope, "stateful-definition", {
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
  });
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  const restateContainer = taskDefinition.addContainer("restate", {
    cpu,
    memoryLimitMiB,
    image:
      statefulProps?.overrideRestateImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(statefulProps?.restateImage ?? DEFAULT_RESTATE_IMAGE),
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
      RUST_BACKTRACE: "full",
      RESTATE_LOG_FORMAT: "json",
      RESTATE_CLUSTER_NAME: clusterName,
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

      RESTATE_INGRESS__EXPERIMENTAL_FEATURE_ENABLE_SEPARATE_INGRESS_ROLE: "true",

      ...(statefulProps?.environment ?? {}),
    },
  });

  restateContainer.addMountPoints({
    sourceVolume: "restate-data",
    containerPath: "/restate-data",
    readOnly: false,
  });

  return taskDefinition;
}

type Listener =
  | {
      type: "network";
      lb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
      listener: cdk.aws_elasticloadbalancingv2.NetworkListener;
      port: number;
      protocol: "http" | "https";
      certificate?: cdk.aws_elasticloadbalancingv2.IListenerCertificate;
    }
  | {
      type: "application";
      lb: cdk.aws_elasticloadbalancingv2.IApplicationLoadBalancer;
      listener: cdk.aws_elasticloadbalancingv2.ApplicationListener;
      port: number;
      protocol: "http" | "https";
      createActions: CreateActions;
      certificate?: cdk.aws_elasticloadbalancingv2.IListenerCertificate;
    };

type MaybeSharedListener = Listener | { type: "shared" };

function createListener(
  scope: Construct,
  name: "ingress" | "admin" | "node",
  source?: ListenerSource,
): MaybeSharedListener {
  if (!source) {
    return { type: "shared" };
  } else {
    if ("networkListenerProps" in source) {
      const listener = new cdk.aws_elasticloadbalancingv2.NetworkListener(
        scope,
        `${name}-listener`,
        source.networkListenerProps,
      );
      cdk.Tags.of(listener).add("Name", listener.node.path);
      return {
        type: "network",
        lb: source.networkListenerProps.loadBalancer,
        listener,
        port: source.networkListenerProps.port,
        protocol: source.networkListenerProps.certificates?.length ? "https" : "http",
        certificate: source.networkListenerProps.certificates?.[0],
      };
    } else if ("applicationListenerProps" in source) {
      const listener = new cdk.aws_elasticloadbalancingv2.ApplicationListener(
        scope,
        `${name}-listener`,
        source.applicationListenerProps,
      );
      cdk.Tags.of(listener).add("Name", listener.node.path);
      return {
        type: "application",
        lb: source.applicationListenerProps.loadBalancer,
        listener,
        port: listener.port,
        protocol: source.applicationListenerProps.certificates?.length ? "https" : "http",
        createActions: source.createActions ?? DEFAULT_ALB_CREATE_ACTION,
        certificate: source.applicationListenerProps.certificates?.[0],
      };
    } else if ("providedNetworkListener" in source) {
      return {
        type: "network",
        lb: source.providedNLB,
        listener: source.providedNetworkListener,
        port: source.port,
        protocol: source.protocol,
        certificate: source.certificate,
      };
    } else if ("providedApplicationListener" in source) {
      return {
        type: "application",
        lb: source.providedALB,
        listener: source.providedApplicationListener,
        port: source.providedApplicationListener.port,
        protocol: source.protocol,
        createActions: source.createActions ?? DEFAULT_ALB_CREATE_ACTION,
        certificate: source.certificate,
      };
    } else {
      throw new Error(`Invalid ListenerSource: ${source}`);
    }
  }
}

type LoadBalancer =
  | {
      type: "network";
      lb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
    }
  | {
      type: "application";
      lb: cdk.aws_elasticloadbalancingv2.IApplicationLoadBalancer;
    };

type TargetGroup =
  | {
      type: "network";
      targetGroup: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    }
  | {
      type: "application";
      targetGroup: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
    };

function createSharedListener(
  scope: Construct,
  name: string,
  port: number,
  maybeShared: MaybeSharedListener,
  sharedLb: LoadBalancer,
): Listener {
  if (maybeShared.type !== "shared") {
    return maybeShared;
  }

  if (sharedLb.type == "network") {
    const networkListener = new cdk.aws_elasticloadbalancingv2.NetworkListener(scope, `${name}-listener`, {
      loadBalancer: sharedLb.lb,
      port,
    });
    cdk.Tags.of(networkListener).add("Name", networkListener.node.path);
    return {
      type: "network",
      lb: sharedLb.lb,
      listener: networkListener,
      port,
      protocol: "http",
    };
  } else if (sharedLb.type == "application") {
    const applicationListener = new cdk.aws_elasticloadbalancingv2.ApplicationListener(scope, `${name}-listener`, {
      loadBalancer: sharedLb.lb,
      port,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });
    cdk.Tags.of(applicationListener).add("Name", applicationListener.node.path);
    return {
      type: "application",
      lb: sharedLb.lb,
      listener: applicationListener,
      port,
      protocol: "http",
      createActions: DEFAULT_ALB_CREATE_ACTION,
    };
  } else {
    throw new Error(`Invalid LoadBalancer: ${sharedLb}`);
  }
}

function createSharedLb(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  {
    ingress,
    admin,
    node,
  }: {
    ingress: MaybeSharedListener;
    admin: MaybeSharedListener;
    node: MaybeSharedListener;
  },
  props?: RestateBYOCLoadBalancerProps,
): { ingress: Listener; admin: Listener; node: Listener } {
  if (ingress.type !== "shared" && admin.type !== "shared" && node.type !== "shared") {
    return { ingress, admin, node };
  }

  let sharedLb: LoadBalancer;
  if (!props?.shared) {
    const lb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(scope, "shared-nlb", {
      vpc,
      securityGroups,
      vpcSubnets,
      internetFacing: false,
      clientRoutingPolicy: cdk.aws_elasticloadbalancingv2.ClientRoutingPolicy.AVAILABILITY_ZONE_AFFINITY,
      crossZoneEnabled: false,
    });
    cdk.Tags.of(lb).add("Name", lb.node.path);
    sharedLb = { type: "network", lb };
  } else if ("nlbProps" in props.shared) {
    const lb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(scope, "shared-nlb", props.shared.nlbProps);
    cdk.Tags.of(lb).add("Name", lb.node.path);
    sharedLb = { type: "network", lb };
  } else if ("albProps" in props.shared) {
    const lb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(scope, "shared-alb", props.shared.albProps);
    cdk.Tags.of(lb).add("Name", lb.node.path);
    sharedLb = { type: "application", lb };
  } else if ("nlb" in props.shared) {
    const lb = props.shared.nlb;
    sharedLb = { type: "network", lb };
  } else if ("alb" in props.shared) {
    const lb = props.shared.alb;
    sharedLb = { type: "application", lb };
  } else {
    throw new Error(`Invalid RestateBYOCLoadBalancerProps: ${props}`);
  }

  return {
    ingress: createSharedListener(scope, "ingress", 8080, ingress, sharedLb),
    admin: createSharedListener(scope, "admin", 9070, admin, sharedLb),
    node: createSharedListener(scope, "node", 5122, node, sharedLb),
  };
}

function createTargetGroup(
  scope: Construct,
  name: "ingress" | "admin" | "node",
  listener: Listener,
  props: cdk.aws_elasticloadbalancingv2.BaseTargetGroupProps,
  targets: cdk.aws_ecs.IEcsLoadBalancerTarget[],
  port: number,
): TargetGroup & Listener {
  if (listener.type == "network") {
    const targetGroup = new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(scope, `${name}-target`, {
      ...props,
      targets,
      port,
      protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
    });
    cdk.Tags.of(targetGroup).add("Name", targetGroup.node.path);
    listener.listener.addAction(`${name}-action`, {
      action: cdk.aws_elasticloadbalancingv2.NetworkListenerAction.forward([targetGroup]),
    });
    return {
      ...listener,
      targetGroup: targetGroup,
    };
  } else if (listener.type == "application") {
    const targetGroup = new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(scope, `${name}-target`, {
      ...props,
      targets,
      port,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });
    cdk.Tags.of(targetGroup).add("Name", targetGroup.node.path);

    const actions = listener.createActions(targetGroup);
    for (const { id, props } of actions) {
      listener.listener.addAction(id, props);
    }

    return {
      ...listener,
      targetGroup: targetGroup,
    };
  } else {
    throw new Error(`Invalid Listener: ${listener}`);
  }
}

function createListeners(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  props?: RestateBYOCLoadBalancerProps,
): {
  ingress: Listener;
  admin: Listener;
  node: Listener;
} {
  const maybeSharedListeners = {
    ingress: createListener(scope, "ingress", props?.ingress),
    admin: createListener(scope, "admin", props?.admin),
    node: createListener(scope, "node", props?.node),
  };

  const listeners = createSharedLb(scope, vpc, securityGroups, vpcSubnets, maybeSharedListeners, props);

  return listeners;
}
function createTargetGroups(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  listeners: {
    ingress: Listener;
    admin: Listener;
    node: Listener;
  },
  statelessService: cdk.aws_ecs.FargateService,
): {
  ingress: Listener & TargetGroup;
  admin: Listener & TargetGroup;
  node: Listener & TargetGroup;
} {
  const ingress = createTargetGroup(
    scope,
    "ingress",
    listeners.ingress,
    {
      vpc,
      healthCheck: {
        enabled: true,
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        path: "/restate/health",
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
      },
    },
    [
      statelessService.loadBalancerTarget({
        containerName: "restate",
        containerPort: 8080,
      }),
    ],
    8080,
  );

  const admin = createTargetGroup(
    scope,
    "admin",
    listeners.admin,
    {
      vpc,
      healthCheck: {
        enabled: true,
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        path: "/health",
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        port: "9070",
      },
    },
    [
      statelessService.loadBalancerTarget({
        containerName: "restate",
        containerPort: 9070,
      }),
    ],
    9070,
  );

  const node = createTargetGroup(
    scope,
    "node",
    listeners.node,
    {
      vpc,
      healthCheck: {
        enabled: true,
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        path: "/health",
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        port: "5122",
      },
    },
    [
      statelessService.loadBalancerTarget({
        containerName: "restate",
        containerPort: 5122,
      }),
    ],
    5122,
  );

  return {
    ingress,
    admin,
    node,
  };
}

function createController(
  scope: Construct,
  licenseID: string,
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
    cpuArchitecture: controllerProps?.tasks?.cpuArchitecture ?? cdk.aws_ecs.CpuArchitecture.ARM64,
  };

  const cpu = controllerProps?.resources?.cpu ?? DEFAULT_CONTROLLER_CPU;
  const memoryLimitMiB = controllerProps?.resources?.memoryLimitMiB ?? DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB;

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(scope, "controller-definition", {
    cpu,
    memoryLimitMiB,
    runtimePlatform: {
      cpuArchitecture: controllerTaskProps.cpuArchitecture,
      operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
    },
    executionRole: controllerTaskProps.executionRole,
    taskRole: controllerTaskProps.taskRole,
  });
  cdk.Tags.of(taskDefinition).add("Name", taskDefinition.node.path);

  let volumeRole: cdk.aws_iam.IRole | undefined;
  if (statefulProps?.ebsVolume) {
    if (statefulProps.ebsVolume.volumeRole) {
      volumeRole = statefulProps.ebsVolume.volumeRole;
    } else {
      volumeRole = new cdk.aws_iam.Role(scope, "volume-role", {
        inlinePolicies: { volume: VOLUME_POLICY },
        assumedBy: cdk.aws_iam.ServicePrincipal.fromStaticServicePrincipleName("ecs.amazonaws.com"),
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

      set(["COUNT"], statefulProps?.nodesPerAz ?? DEFAULT_STATEFUL_NODES_PER_AZ);
      set(["TASK_DEFINITION_ARN"], statefulDefinition.taskDefinitionArn);
      set(["SUBNETS"], `["${subnetId}"]`);
      set(["SECURITY_GROUPS"], `[${securityGroups.map(({ securityGroupId }) => `"${securityGroupId}"`).join(",")}]`);
      set(["ENABLE_EXECUTE_COMMAND"], `${restateTaskProps.enableExecuteCommand}`);

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
    CONTROLLER_LICENSE_ID: licenseID,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__REGION`]: cdk.Aws.REGION,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__CLUSTER_ARN`]: cluster.clusterArn,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__TASK_PREFIX`]: clusterTaskPrefix,
    ...zoneEnvs,
  };

  taskDefinition.addContainer("controller", {
    cpu,
    memoryLimitMiB,
    image:
      controllerProps?.overrideControllerImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(controllerProps?.controllerImage ?? DEFAULT_CONTROLLER_IMAGE),
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
    `${cdk.Fn.join(":", cdk.Fn.split(":", statefulDefinition.taskDefinitionArn, 7).slice(0, 6))}:*`;

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
      resources: [restateTaskProps.taskRole.roleArn, restateTaskProps.executionRole.roleArn],
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
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
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
    code: cdk.aws_lambda.Code.fromAsset(`${__dirname}/lambda/retirement-watcher`),
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
        eventTypeCode: cdk.aws_events.Match.equalsIgnoreCase("AWS_ECS_TASK_PATCHING_RETIREMENT"),
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
  const clusterTaskPrefixBeforeSlash = cdk.Fn.join(":", clusterColonParts.slice(0, 5).concat(["task"]));
  // ["arn:aws:ecs:eu-central-1:211125428070:task","cluster-name",""]
  const clusterTaskPrefix = cdk.Fn.join("/", [clusterTaskPrefixBeforeSlash, clusterSlashParts[1], ""]);
  // arn:aws:ecs:eu-central-1:211125428070:task/cluster-name/
  return clusterTaskPrefix;
}

function createRestatectl(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  vpcSubnets: cdk.aws_ec2.SelectedSubnets,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  address: string,
  restatectlProps?: RestateBYOCRestatectlProps,
): cdk.aws_lambda.Function | undefined {
  if (restatectlProps?.disabled) return;

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
  RESTATE_NODE_NAME=$(jq -r '.TaskARN' task-metadata) \
  RESTATE_LOCATION="$AWS_REGION.$(jq -r '.AvailabilityZone' task-metadata)" \
  RESTATE_ADVERTISED_ADDRESS="http://$(jq -r '.Containers[0].Networks[0].IPv4Addresses[0]' task-metadata):5122"
exec restate-server
`;

function validateRestateVersion(node?: RestateBYOCNodeProps): SupportedRestateVersion {
  const restateVersion = node?.restateVersion ?? (node?.restateImage ?? DEFAULT_RESTATE_IMAGE).split(":").pop();

  if (!restateVersion)
    throw new Error(
      `Could not derive the version of restate from the provided image ${node?.restateImage ?? DEFAULT_RESTATE_IMAGE}, a restateVersion parameter must be provided`,
    );

  assertSupportedRestateVersion(restateVersion);
  return restateVersion;
}

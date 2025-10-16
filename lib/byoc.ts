import type { IRestateEnvironment } from "@restatedev/restate-cdk";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { bundleArtifacts, getArtifacts } from "./artifacts";
import { createMonitoring, otelCollectorContainerProps } from "./monitoring";
import { createOutputs } from "./outputs";
import {
  assertSupportedRestateVersion,
  ClusterProps,
  ControllerProps,
  DEFAULT_CONTROLLER_CPU,
  DEFAULT_CONTROLLER_IMAGE,
  DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB,
  DEFAULT_CONTROLLER_SNAPSHOT_RETENTION,
  DEFAULT_PARTITIONS,
  DEFAULT_RESTATE_CPU,
  DEFAULT_RESTATE_IMAGE,
  DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
  DEFAULT_STATEFUL_NODES_PER_AZ,
  DEFAULT_STATELESS_DESIRED_COUNT,
  TaskProps,
  LoadBalancerProps,
  NodeProps,
  RestatectlProps,
  StatefulNodeProps,
  StatelessNodeProps,
  SupportedRestateVersion,
  TaskRetirementWatcherProps,
} from "./props";
import { VOLUME_POLICY } from "./volume-policy";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PACKAGE_INFO = require("../package.json");

export class RestateEcsFargateCluster
  extends Construct
  implements
    cdk.aws_ec2.IConnectable,
    cdk.aws_iam.IGrantable,
    IRestateEnvironment
{
  /**
   * The name of the cluster
   */
  public readonly clusterName: string;
  /**
   * The VPC of the cluster
   */
  public readonly vpc: cdk.aws_ec2.IVpc;
  /**
   * The subnets of the cluster
   */
  public readonly vpcSubnets: cdk.aws_ec2.SelectedSubnets;
  /**
   * The security groups of the cluster
   */
  public readonly securityGroups: cdk.aws_ec2.ISecurityGroup[];
  /**
   * The bucket where metadata and snapshots are stored
   */
  public readonly bucket: cdk.aws_s3.IBucket;
  /**
   * Implements the IConnectable interface
   */
  public readonly connections: cdk.aws_ec2.Connections;
  /**
   * Properties relating to the stateless nodes
   */
  public readonly stateless: {
    /**
     * The stateless node service
     */
    service: cdk.aws_ecs.IFargateService;
    /**
     * The stateless node task definition
     */
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  };
  /**
   * Properties relating to the stateful nodes
   */
  public readonly stateful: {
    /**
     * The stateful node task definition
     */
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
  };
  /**
   * Properties relating to the controller service
   */
  public readonly controller: {
    /**
     * The controller service
     */
    service: cdk.aws_ecs.IFargateService;
    /**
     * The controller task definition
     */
    taskDefinition: cdk.aws_ecs.IFargateTaskDefinition;
    /**
     * The role passed by the controller to AWS to manage EBS volumes.
     * Only present if EBS volumes are being used
     */
    volumeRole?: cdk.aws_iam.IRole;
  };
  /**
   * Properties of the listeners managed by this construct
   */
  public readonly listeners: {
    /**
     * The ingress listener properties
     */
    ingress: Listener;
    /**
     * The admin listener properties
     */
    admin: Listener;
    /**
     * The node listener properties
     */
    node: Listener;
  };

  /**
   * Properties of the target groups managed by this construct. Application Load Balancer support is optional and
   * can be activated via {@link ClusterProps}'s `loadBalancer` property when you create the cluster.
   */
  public readonly targetGroups: {
    /**
     * The ingress target groups
     */
    ingress: {
      /**
       * To enable the ALB target group, set `loadBalancer.createAlbTargets` = `true` in {@link ClusterProps}.
       */
      application: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
      network: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    };
    /**
     * The admin target groups
     */
    admin: {
      /**
       * To enable the ALB target group, set `loadBalancer.createAlbTargets` = `true` in {@link ClusterProps}.
       */
      application: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
      network: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    };
    /**
     * The node target group. Only an NLB target group is created as a ECS service has a limit of 5 overall.
     */
    node: {
      network: cdk.aws_elasticloadbalancingv2.INetworkTargetGroup;
    };
  };

  /**
   * The ECS cluster
   */
  public readonly ecsCluster: cdk.aws_ecs.ICluster;
  /**
   * The task role of the Restate tasks
   */
  public readonly restateTaskRole: cdk.aws_iam.IRole;
  /**
   * The task execution role of the Restate tasks
   */
  public readonly restateExecutionRole: cdk.aws_iam.IRole;
  /**
   * The task role of the Restate tasks, implements the IGrantable interface
   */
  public readonly grantPrincipal: cdk.aws_iam.IPrincipal;

  /**
   * The restatectl lambda
   */
  public readonly restatectl?: cdk.aws_lambda.IFunction;
  /**
   * Properties of the retirement watcher lambda
   */
  public readonly retirementWatcher?: {
    /**
     * The retirement watcher lambda function
     */
    fn: cdk.aws_lambda.IFunction;
    /**
     * The retirement watcher SQS queue
     */
    queue: cdk.aws_sqs.IQueue;
    /**
     * The retirement watcher EventBridge rule
     */
    rule: cdk.aws_events.IRule;
  };

  /**
   * Monitoring properties
   */
  public readonly monitoring: {
    /**
     * Metrics dashboard
     */
    metricsDashboard?: cdk.aws_cloudwatch.Dashboard;
    /**
     * Control panel dashboard
     */
    controlPanelDashboard?: cdk.aws_cloudwatch.Dashboard;
    /**
     * The custom widget lambda
     */
    customWidgetFn?: cdk.aws_lambda.IFunction;
  };

  /**
   * CloudWatch log groups
   */
  public readonly logGroups: {
    /**
     * Log group for restate tasks (stateless and stateful nodes)
     */
    restate: cdk.aws_logs.ILogGroup;
    /**
     * Log group for controller task
     */
    controller: cdk.aws_logs.ILogGroup;
    /**
     * Log group for restatectl lambda
     */
    restatectl?: cdk.aws_logs.ILogGroup;
    /**
     * Log group for retirement watcher lambda
     */
    retirementWatcher?: cdk.aws_logs.ILogGroup;
    /**
     * Log group for custom widget lambda
     */
    customWidget?: cdk.aws_logs.ILogGroup;
  };

  /**
   * Implements IRestateEnvironment
   **/
  public readonly adminUrl: string;

  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id);

    if (!props.vpc) throw new Error("A VPC must be provided");
    if (!props.licenseKey) throw new Error("A license key must be provided");

    this.clusterName = props.clusterName ?? this.node.path;

    this.vpc = props.vpc;

    this.vpcSubnets = this.vpc.selectSubnets(
      props.subnets ?? {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true,
      },
    );

    if (
      (props.statelessNode?.defaultReplication &&
        "zone" in props.statelessNode.defaultReplication) ||
      props.statelessNode?.defaultReplication === undefined
    ) {
      const zoneReplication =
        props.statelessNode?.defaultReplication?.zone ?? 2;
      const zoneCount = new Set(this.vpcSubnets.availabilityZones).size;
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
    if (props.objectStorage?.prefix) {
      bucketPath = `s3://${this.bucket.bucketName}/${props.objectStorage.prefix}`;
    } else {
      bucketPath = `s3://${this.bucket.bucketName}`;
    }

    if (props.ecsCluster) {
      this.ecsCluster = props.ecsCluster;
    } else {
      const containerInsights =
        props.monitoring?.containerInsights ??
        cdk.aws_ecs.ContainerInsights.ENHANCED;

      const cluster = new cdk.aws_ecs.Cluster(this, "cluster", {
        vpc: this.vpc,
        clusterName: props.clusterName,
        containerInsightsV2: containerInsights,
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

    const ecsTaskRetention =
      props.logRetention?.ecsTasks ??
      props.logRetention?.default ??
      cdk.aws_logs.RetentionDays.ONE_MONTH;

    const restateLogGroup = new cdk.aws_logs.LogGroup(
      this,
      "restate-log-group",
      {
        retention: ecsTaskRetention,
      },
    );

    const controllerLogGroup = new cdk.aws_logs.LogGroup(
      this,
      "controller-log-group",
      {
        retention: ecsTaskRetention,
      },
    );

    const restateTaskProps: TaskProps = {
      taskRole: this.restateTaskRole,
      executionRole: this.restateExecutionRole,
      logDriver:
        props.restateTasks?.logDriver ??
        cdk.aws_ecs.LogDriver.awsLogs({
          streamPrefix: "restate",
          logGroup: restateLogGroup,
          mode: cdk.aws_ecs.AwsLogDriverMode.NON_BLOCKING,
        }),
      enableExecuteCommand: props.restateTasks?.enableExecuteCommand ?? false,
      cpuArchitecture:
        props.restateTasks?.cpuArchitecture ??
        cdk.aws_ecs.CpuArchitecture.ARM64,
    };

    this.listeners = createListeners(
      this,
      this.vpc,
      this.securityGroups,
      this.vpcSubnets,
      props.loadBalancer,
    );

    const otelCollectorContainer = otelCollectorContainerProps(
      this.clusterName,
      restateTaskProps.logDriver,
      props.monitoring?.otelCollector,
    );

    const otelEnv = props.monitoring?.otelCollector?.traceOptions?.sampler
      ? {
          OTEL_SAMPLER: props.monitoring?.otelCollector.traceOptions.sampler,
          ...("samplerArg" in props.monitoring.otelCollector.traceOptions
            ? {
                OTEL_SAMPLER_ARG:
                  props.monitoring.otelCollector.traceOptions.samplerArg,
              }
            : {}),
          RESTATE_TRACING_SERVICES_ENDPOINT: "http://127.0.0.1:4317",
        }
      : {};

    const stateless = createStateless(
      this,
      this.clusterName,
      bucketPath,
      this.ecsCluster,
      this.securityGroups,
      this.vpcSubnets,
      restateTaskProps,
      props.addresses?.ingress ?? this.listeners.ingress.address,
      otelEnv,
      props.statelessNode,
      otelCollectorContainer,
    );
    this.stateless = stateless;

    // we may have some refs so we have to build a bash-evaluatable string
    let partitionsPerNode: string;
    {
      const azCount = new Set(this.vpcSubnets.availabilityZones).size;
      const nodesPerAz =
        props.statefulNode?.nodesPerAz ?? DEFAULT_STATEFUL_NODES_PER_AZ;
      const replicationFactor = props.statelessNode?.defaultReplication
        ? "zone" in props.statelessNode.defaultReplication
          ? props.statelessNode.defaultReplication.zone
          : props.statelessNode.defaultReplication.node
        : 2;
      const partitionCount =
        props.statelessNode?.defaultPartitions ?? DEFAULT_PARTITIONS;
      partitionsPerNode = `(${partitionCount} * ${replicationFactor}) / (${azCount} * ${nodesPerAz})`;
    }

    const statefulDefinition = createStatefulDefinition(
      this,
      this.clusterName,
      bucketPath,
      restateTaskProps,
      partitionsPerNode,
      otelEnv,
      props.statefulNode,
      otelCollectorContainer,
    );
    this.stateful = { taskDefinition: statefulDefinition };

    const { albTargetProps, nlbTargetProps } = createTargetProps(
      this.vpc,
      stateless.service,
    );

    const ingressTargetGroup = createNetworkTargetGroup(
      this,
      "ingress",
      this.listeners.ingress,
      nlbTargetProps.ingress,
    );
    stateless.service.node.addDependency(
      ingressTargetGroup.loadBalancerAttached,
    );

    const adminTargetGroup = createNetworkTargetGroup(
      this,
      "admin",
      this.listeners.admin,
      nlbTargetProps.admin,
    );
    stateless.service.node.addDependency(adminTargetGroup.loadBalancerAttached);

    const nodeTargetGroup = createNetworkTargetGroup(
      this,
      "node",
      this.listeners.node,
      nlbTargetProps.node,
    );
    stateless.service.node.addDependency(nodeTargetGroup.loadBalancerAttached);

    const getIngressApplicationTargetGroup = () => {
      const ingressApplicationTargetGroup = createApplicationTargetGroup(
        this,
        "ingress",
        albTargetProps.ingress,
      );
      this.stateless.service.node.addDependency(
        ingressApplicationTargetGroup.loadBalancerAttached,
      );

      new cdk.CfnOutput(this, "IngressApplicationTargetGroup", {
        description:
          "The ARN of the application target group for the ingress port",
        value: ingressApplicationTargetGroup.targetGroupArn,
      });

      return ingressApplicationTargetGroup;
    };

    const getAdminApplicationTargetGroup = () => {
      const adminApplicationTargetGroup = createApplicationTargetGroup(
        this,
        "admin",
        albTargetProps.admin,
      );
      this.stateless.service.node.addDependency(
        adminApplicationTargetGroup.loadBalancerAttached,
      );

      new cdk.CfnOutput(this, "AdminApplicationTargetGroup", {
        description:
          "The ARN of the application target group for the admin port",
        value: adminApplicationTargetGroup.targetGroupArn,
      });

      return adminApplicationTargetGroup;
    };

    const targetGroups = {
      ingress: {
        network: ingressTargetGroup,
      },
      admin: {
        network: adminTargetGroup,
      },
      node: {
        network: nodeTargetGroup,
      },
    };

    if (props.loadBalancer?.createAlbTargets) {
      this.targetGroups = {
        ...targetGroups,
        ingress: {
          ...targetGroups.ingress,
          application: getIngressApplicationTargetGroup(),
        },
        admin: {
          ...targetGroups.admin,
          application: getAdminApplicationTargetGroup(),
        },
      };
    } else {
      this.targetGroups = {
        ...targetGroups,
        ingress: {
          ...targetGroups.ingress,
          get application() {
            delete (
              this as {
                application?: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
              }
            ).application;
            this.application = getIngressApplicationTargetGroup();
            return this.application;
          },
        },
        admin: {
          ...targetGroups.admin,
          get application() {
            delete (
              this as {
                application?: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
              }
            ).application;
            this.application = getAdminApplicationTargetGroup();
            return this.application;
          },
        },
      };
    }

    this.adminUrl = this.listeners.admin.address;

    const ctPrefix = clusterTaskPrefix(this.ecsCluster.clusterArn);

    const controller = createController(
      this,
      props.licenseKey,
      bucketPath,
      this.ecsCluster,
      ctPrefix,
      this.vpcSubnets,
      this.securityGroups,
      this.stateful.taskDefinition,
      restateTaskProps,
      controllerLogGroup,
      props.statefulNode,
      props.controller,
    );
    this.controller = controller;

    const artifacts = !props._useLocalArtifacts
      ? getArtifacts(this, props._artifactsVersion ?? PACKAGE_INFO.version)
      : bundleArtifacts();

    const lambdaRetention =
      props.logRetention?.lambdaFunctions ??
      props.logRetention?.default ??
      cdk.aws_logs.RetentionDays.TWO_WEEKS;

    const restatectlResult = createRestatectl(
      this,
      this.vpc,
      this.vpcSubnets,
      this.securityGroups,
      this.listeners.node.address,
      artifacts["restatectl.zip"],
      lambdaRetention,
      props.restatectl,
    );
    this.restatectl = restatectlResult?.fn;

    const retirementWatcherResult = createRetirementWatcher(
      this,
      this.vpc,
      this.vpcSubnets,
      ctPrefix,
      artifacts["retirement-watcher.zip"],
      lambdaRetention,
      props.retirementWatcher,
    );
    this.retirementWatcher = retirementWatcherResult
      ? {
          fn: retirementWatcherResult.fn,
          queue: retirementWatcherResult.queue,
          rule: retirementWatcherResult.rule,
        }
      : undefined;

    const monitoring = createMonitoring(
      this,
      PACKAGE_INFO.version,
      this.clusterName,
      this.vpc,
      this.vpcSubnets,
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
          loadBalancerArn: this.listeners.ingress.lb.loadBalancerArn,
          certificateArn: this.listeners.ingress.certificate?.certificateArn,
          address: props.addresses?.ingress ?? this.listeners.ingress.address,
        },
        admin: {
          loadBalancerArn: this.listeners.admin.lb.loadBalancerArn,
          address: props.addresses?.admin ?? this.listeners.admin.address,
        },
        webUI: {
          address:
            props.addresses?.webUI ?? `${this.listeners.admin.address}/ui`,
        },
      },
      artifacts["cloudwatch-custom-widget.zip"],
      lambdaRetention,
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

    // Expose log groups as public properties
    this.logGroups = {
      restate: restateLogGroup,
      controller: controllerLogGroup,
      restatectl: restatectlResult?.logGroup,
      retirementWatcher: retirementWatcherResult?.logGroup,
      customWidget: monitoring?.customWidgetLogGroup,
    };

    createOutputs(this);
  }
}

function createStateless(
  scope: Construct,
  clusterName: string,
  bucketPath: `s3://${string}`,
  cluster: cdk.aws_ecs.ICluster,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  taskProps: TaskProps,
  ingressAdvertisedAddress: string,
  otelEnv: Record<string, string>,
  statelessProps?: StatelessNodeProps,
  otelCollectorContainer?: cdk.aws_ecs.ContainerDefinitionOptions,
): {
  service: cdk.aws_ecs.FargateService;
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition;
} {
  const totalCpu = statelessProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const totalMemoryLimitMiB =
    statelessProps?.resources?.memoryLimitMiB ??
    DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

  const restateCpu = totalCpu - (otelCollectorContainer?.cpu ?? 0);
  const restateMemoryLimitMiB =
    totalMemoryLimitMiB - (otelCollectorContainer?.memoryLimitMiB ?? 0);

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "stateless-definition",
    {
      cpu: totalCpu,
      memoryLimitMiB: totalMemoryLimitMiB,
      runtimePlatform: {
        cpuArchitecture: taskProps.cpuArchitecture,
        operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: taskProps.taskRole,
      executionRole: taskProps.executionRole,
    },
  );
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
    cpu: restateCpu,
    memoryLimitMiB: restateMemoryLimitMiB,
    entryPoint: ["bash", "-c", statelessEntryPointScript],
    image:
      statelessProps?._restateImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(
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
      RESTATE_CLUSTER_NAME: clusterName,
      RESTATE_ROLES: '["admin","http-ingress"]',
      RESTATE_AUTO_PROVISION: "true",
      RESTATE_SHUTDOWN_TIMEOUT: "100s", // fargate allows 120s
      RESTATE_DEFAULT_NUM_PARTITIONS: `${statelessProps?.defaultPartitions ?? DEFAULT_PARTITIONS}`,
      RESTATE_DEFAULT_REPLICATION: replication,

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_BIFROST__DEFAULT_PROVIDER: "replicated",

      RESTATE_INGRESS__ADVERTISED_INGRESS_ENDPOINT:
        statelessProps?.ingressAdvertisedAddress ?? ingressAdvertisedAddress,

      // why? this isn't a worker! because the admin uses the presence of this flag as a signal of how to trim
      RESTATE_WORKER__SNAPSHOTS__DESTINATION: `${bucketPath}/snapshots`,

      ...otelEnv,
      ...statelessProps?.environment,
    },
  });

  if (otelCollectorContainer) {
    taskDefinition.addContainer("otel-collector", otelCollectorContainer);
  }

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
    availabilityZoneRebalancing:
      cdk.aws_ecs.AvailabilityZoneRebalancing.ENABLED,
    propagateTags: cdk.aws_ecs.PropagatedTagSource.TASK_DEFINITION,
    deploymentController: {
      type: cdk.aws_ecs.DeploymentControllerType.ECS,
    },
  });
  cdk.Tags.of(service).add("Name", service.node.path);

  return { service, taskDefinition };
}

function createStatefulDefinition(
  scope: Construct,
  clusterName: string,
  bucketPath: `s3://${string}`,
  taskProps: TaskProps,
  partitionsPerNode: string,
  otelEnv: Record<string, string>,
  statefulProps?: StatefulNodeProps,
  otelCollectorContainer?: cdk.aws_ecs.ContainerDefinitionOptions,
) {
  const totalCpu = statefulProps?.resources?.cpu ?? DEFAULT_RESTATE_CPU;
  const totalMemoryLimitMiB =
    statefulProps?.resources?.memoryLimitMiB ??
    DEFAULT_RESTATE_MEMORY_LIMIT_MIB;

  const restateCpu = totalCpu - (otelCollectorContainer?.cpu ?? 0);
  const restateMemoryLimitMiB =
    totalMemoryLimitMiB - (otelCollectorContainer?.memoryLimitMiB ?? 0);

  const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
    scope,
    "stateful-definition",
    {
      cpu: totalCpu,
      memoryLimitMiB: totalMemoryLimitMiB,
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
    cpu: restateCpu,
    memoryLimitMiB: restateMemoryLimitMiB,
    image:
      statefulProps?._restateImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(
        statefulProps?.restateImage ?? DEFAULT_RESTATE_IMAGE,
      ),
    entryPoint: ["bash", "-c", statefulEntryPointScript],
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
      RESTATE_CLUSTER_NAME: clusterName,
      RESTATE_ROLES: '["log-server", "worker"]',
      RESTATE_AUTO_PROVISION: "false",
      RESTATE_SHUTDOWN_TIMEOUT: "100s", // fargate allows 120s

      RESTATE_METADATA_CLIENT__TYPE: "object-store",
      RESTATE_METADATA_CLIENT__PATH: `${bucketPath}/metadata`,

      RESTATE_WORKER__SNAPSHOTS__DESTINATION: `${bucketPath}/snapshots`,
      RESTATE_WORKER__SNAPSHOTS__SNAPSHOT_INTERVAL_NUM_RECORDS: "1000000",

      RESTATE_WORKER__STORAGE__ROCKSDB_DISABLE_DIRECT_IO_FOR_READS: "true",
      RESTATE_WORKER__STORAGE__ROCKSDB_DISABLE_WAL_FSYNC: "true",
      RESTATE_WORKER__STORAGE__NUM_PARTITIONS_TO_SHARE_MEMORY_BUDGET: `${partitionsPerNode}`,

      RESTATE_LOG_SERVER__ROCKSDB_DISABLE_WAL_FSYNC: "true",
      RESTATE_LOG_SERVER__ROCKSDB_DISABLE_DIRECT_IO_FOR_READS: "true",

      ...otelEnv,
      ...(statefulProps?.environment ?? {}),
    },
  });

  restateContainer.addMountPoints({
    sourceVolume: "restate-data",
    containerPath: "/restate-data",
    readOnly: false,
  });

  if (otelCollectorContainer) {
    taskDefinition.addContainer("otel-collector", otelCollectorContainer);
  }

  return taskDefinition;
}

type Listener = {
  type: "network";
  lb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
  listener: cdk.aws_elasticloadbalancingv2.NetworkListener;
  port: number;
  protocol: "http" | "https";
  address: string;
  certificate?: cdk.aws_elasticloadbalancingv2.IListenerCertificate;
};

type LoadBalancer = {
  type: "network";
  lb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
};

function createSharedListener(
  scope: Construct,
  name: string,
  port: number,
  sharedLb: LoadBalancer,
): Listener {
  if (sharedLb.type == "network") {
    const networkListener = new cdk.aws_elasticloadbalancingv2.NetworkListener(
      scope,
      `${name}-shared-listener`,
      {
        loadBalancer: sharedLb.lb,
        port,
      },
    );
    cdk.Tags.of(networkListener).add("Name", networkListener.node.path);
    return {
      type: "network",
      lb: sharedLb.lb,
      listener: networkListener,
      port,
      protocol: "http",
      address: `http://${sharedLb.lb.loadBalancerDnsName}:${port}`,
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
  props?: LoadBalancerProps,
): { ingress: Listener; admin: Listener; node: Listener } {
  let sharedLb: LoadBalancer;
  if (!props?.shared) {
    const lb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(
      scope,
      "shared-nlb",
      {
        vpc,
        securityGroups,
        vpcSubnets,
        internetFacing: false,
        clientRoutingPolicy:
          cdk.aws_elasticloadbalancingv2.ClientRoutingPolicy
            .AVAILABILITY_ZONE_AFFINITY,
        crossZoneEnabled: false,
      },
    );
    cdk.Tags.of(lb).add("Name", lb.node.path);
    sharedLb = { type: "network", lb };
  } else if ("nlbProps" in props.shared) {
    const lb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(
      scope,
      "shared-nlb",
      props.shared.nlbProps,
    );
    cdk.Tags.of(lb).add("Name", lb.node.path);
    sharedLb = { type: "network", lb };
  } else if ("nlb" in props.shared) {
    const lb = props.shared.nlb;
    sharedLb = { type: "network", lb };
  } else {
    throw new Error(`Invalid LoadBalancerProps: ${props}`);
  }

  return {
    ingress: createSharedListener(scope, "ingress", 8080, sharedLb),
    admin: createSharedListener(scope, "admin", 9070, sharedLb),
    node: createSharedListener(scope, "node", 5122, sharedLb),
  };
}

function createNetworkTargetGroup(
  scope: Construct,
  targetName: "ingress" | "admin" | "node",
  listener: Listener,
  props: cdk.aws_elasticloadbalancingv2.NetworkTargetGroupProps,
): cdk.aws_elasticloadbalancingv2.INetworkTargetGroup {
  if (listener.type == "network") {
    const targetGroup = new cdk.aws_elasticloadbalancingv2.NetworkTargetGroup(
      scope,
      `${targetName}-shared-target`,
      props,
    );
    cdk.Tags.of(targetGroup).add("Name", targetGroup.node.path);
    listener.listener.addAction(`${targetName}-shared-action`, {
      action: cdk.aws_elasticloadbalancingv2.NetworkListenerAction.forward([
        targetGroup,
      ]),
    });
    return targetGroup;
  } else {
    throw new Error(`Invalid Listener: ${listener}`);
  }
}

function createApplicationTargetGroup(
  scope: Construct,
  targetName: "ingress" | "admin",
  props: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroupProps,
): cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup {
  const targetGroup = new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
    scope,
    `${targetName}-application-target`,
    props,
  );
  cdk.Tags.of(targetGroup).add("Name", targetGroup.node.path);

  return targetGroup;
}

function createListeners(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  vpcSubnets: cdk.aws_ec2.SubnetSelection,
  props?: LoadBalancerProps,
): {
  ingress: Listener;
  admin: Listener;
  node: Listener;
} {
  const sharedListeners = createSharedLb(
    scope,
    vpc,
    securityGroups,
    vpcSubnets,
    props,
  );

  return sharedListeners;
}

interface AlbTargetProps {
  ingress: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroupProps;
  admin: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroupProps;
}

function createTargetProps(
  vpc: cdk.aws_ec2.IVpc,
  statelessService: cdk.aws_ecs.FargateService,
): {
  albTargetProps: AlbTargetProps;
  nlbTargetProps: {
    ingress: cdk.aws_elasticloadbalancingv2.NetworkTargetGroupProps;
    admin: cdk.aws_elasticloadbalancingv2.NetworkTargetGroupProps;
    node: cdk.aws_elasticloadbalancingv2.NetworkTargetGroupProps;
  };
} {
  const ingressProps = {
    vpc,
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
  };

  const adminProps = {
    vpc,
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
  };

  const nodeProps = {
    vpc,
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
  };

  return {
    albTargetProps: {
      ingress: {
        ...ingressProps,
        protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      },
      admin: {
        ...adminProps,
        protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      },
    },
    nlbTargetProps: {
      ingress: {
        ...ingressProps,
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
      },
      admin: {
        ...adminProps,
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
      },
      node: {
        ...nodeProps,
        protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
      },
    },
  };
}

function createController(
  scope: Construct,
  licenseKey: string,
  bucketPath: `s3://${string}`,
  cluster: cdk.aws_ecs.ICluster,
  clusterTaskPrefix: string,
  vpcSubnets: cdk.aws_ec2.SelectedSubnets,
  securityGroups: cdk.aws_ec2.ISecurityGroup[],
  statefulDefinition: cdk.aws_ecs.IFargateTaskDefinition,
  restateTaskProps: TaskProps,
  logGroup: cdk.aws_logs.ILogGroup,
  statefulProps?: StatefulNodeProps,
  controllerProps?: ControllerProps,
): {
  service: cdk.aws_ecs.IFargateService;
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition;
  volumeRole?: cdk.aws_iam.IRole;
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
        logGroup,
        mode: cdk.aws_ecs.AwsLogDriverMode.NON_BLOCKING,
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
      // we retain this so that AWS will still have permissions to delete the volumes even after the stack is removed
      volumeRole.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
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

  const ebsSnapshotRetentionPeriodString = controllerProps?.snapshotRetention
    ?.duration
    ? `${Math.floor(controllerProps.snapshotRetention.duration.toSeconds())}s`
    : DEFAULT_CONTROLLER_SNAPSHOT_RETENTION;

  const ebsSnapshotRetentionEnvs: { [k: string]: string } = controllerProps
    ?.snapshotRetention?.disabled
    ? {}
    : {
        CONTROLLER_EBS_SNAPSHOT_RETENTION_PERIOD:
          ebsSnapshotRetentionPeriodString,
      };

  const config = {
    CONTROLLER_LOG_FORMAT: "json",
    CONTROLLER_METADATA_PATH: `${bucketPath}/metadata`,
    CONTROLLER_RECONCILE_INTERVAL: "10s",
    CONTROLLER_CLUSTER__CLUSTER_ARN: cluster.clusterArn,
    CONTROLLER_LICENSE_KEY: licenseKey,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__REGION`]: cdk.Aws.REGION,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__CLUSTER_ARN`]:
      cluster.clusterArn,
    [`CONTROLLER_ECS_CLUSTERS__${cdk.Aws.REGION}__TASK_PREFIX`]:
      clusterTaskPrefix,
    ...ebsSnapshotRetentionEnvs,
    ...zoneEnvs,
  };

  taskDefinition.addContainer("controller", {
    cpu,
    memoryLimitMiB,
    image:
      controllerProps?._controllerImage ??
      cdk.aws_ecs.ContainerImage.fromRegistry(
        controllerProps?.controllerImage ?? DEFAULT_CONTROLLER_IMAGE,
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
      actions: ["ecs:ListTasks"],
      resources: ["*"],
      conditions: {
        ArnEquals: { "ecs:cluster": cluster.clusterArn },
      },
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "ECSListActions",
    }),
  );

  taskDefinition.taskRole.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ecs:TagResource", "ecs:DescribeTasks", "ecs:StopTask"],
      resources: [`${clusterTaskPrefix}*`],
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

  if (!controllerProps?.snapshotRetention?.disabled) {
    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:DescribeVolumes", "ec2:DescribeSnapshots"],
        resources: ["*"],
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "EC2ListActions",
      }),
    );

    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:CreateSnapshot"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}::snapshot/*`,
        ],
        conditions: {
          ArnEquals: {
            "aws:RequestTag/restate:ecsClusterArn": cluster.clusterArn,
          },
        },
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "CreateSnapshot",
      }),
    );

    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:CreateSnapshot"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
        ],
        conditions: {
          ArnEquals: {
            "aws:ResourceTag/restate:ecsClusterArn": cluster.clusterArn,
          },
        },
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "SnapshotVolume",
      }),
    );

    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}::snapshot/*`,
        ],
        conditions: {
          StringEquals: {
            "ec2:CreateAction": "CreateSnapshot",
          },
        },
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "TagSnapshots",
      }),
    );

    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:DeleteVolume", "ec2:DeleteSnapshot"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}::snapshot/*`,
        ],
        conditions: {
          ArnEquals: {
            "aws:ResourceTag/restate:ecsClusterArn": cluster.clusterArn,
          },
        },
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "DeleteVolumeAndSnapshot",
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
    vpcSubnets,
    propagateTags: cdk.aws_ecs.PropagatedTagSource.TASK_DEFINITION,
    deploymentController: {
      type: cdk.aws_ecs.DeploymentControllerType.ECS,
    },
  });
  cdk.Tags.of(service).add("Name", service.node.path);

  return { service, taskDefinition, volumeRole };
}

function createRetirementWatcher(
  scope: Construct,
  vpc: cdk.aws_ec2.IVpc,
  vpcSubnets: cdk.aws_ec2.SelectedSubnets,
  clusterTaskPrefix: string,
  code: cdk.aws_lambda.Code,
  retention: cdk.aws_logs.RetentionDays,
  retirementWatcherProps?: TaskRetirementWatcherProps,
):
  | {
      fn: cdk.aws_lambda.IFunction;
      queue: cdk.aws_sqs.IQueue;
      rule: cdk.aws_events.IRule;
      logGroup: cdk.aws_logs.ILogGroup;
    }
  | undefined {
  if (retirementWatcherProps?.disabled) return;

  const logGroup = new cdk.aws_logs.LogGroup(
    scope,
    "retirement-watcher-log-group",
    {
      retention,
    },
  );

  const role =
    retirementWatcherProps?.executionRole ??
    new cdk.aws_iam.Role(scope, "retirement-watcher-lambda-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:${logGroup.logGroupName}:log-stream:*`,
      ],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaLogStreamPermissions",
    }),
  );

  if (retirementWatcherProps?.securityGroups?.length) {
    role.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSubnets",
          "ec2:DeleteNetworkInterface",
        ],
        resources: ["*"],
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "AWSLambdaVPCWildcardPermissions",
      }),
    );

    role.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:network-interface/*`,
        ],
        effect: cdk.aws_iam.Effect.ALLOW,
        sid: "AWSLambdaVPCNetworkInterfacePermissions",
      }),
    );
  }

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
    code,
    logGroup,
    timeout: cdk.Duration.seconds(60),
    vpc: retirementWatcherProps?.securityGroups?.length ? vpc : undefined,
    vpcSubnets: retirementWatcherProps?.securityGroups?.length
      ? vpcSubnets
      : undefined,
    securityGroups: retirementWatcherProps?.securityGroups,
  });
  cdk.Tags.of(fn).add("Name", fn.node.path);

  // We use SQS so that we get infinite retries - if we go straight to lambda from eventbridge you only
  // get two retries. We could have a dead letter here and then alert when events go into it.
  const queue = new cdk.aws_sqs.Queue(scope, "retirement-watcher-queue", {
    visibilityTimeout: cdk.Duration.seconds(60),
    ...(retirementWatcherProps?.queueEncryptionKey
      ? {
          encryption: cdk.aws_sqs.QueueEncryption.KMS,
          encryptionMasterKey: retirementWatcherProps.queueEncryptionKey,
        }
      : {
          encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
        }),
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

  return { fn, queue, rule, logGroup };
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
  address: string,
  code: cdk.aws_lambda.Code,
  retention: cdk.aws_logs.RetentionDays,
  restatectlProps?: RestatectlProps,
):
  | {
      fn: cdk.aws_lambda.Function;
      logGroup: cdk.aws_logs.ILogGroup;
    }
  | undefined {
  if (restatectlProps?.disabled) return;

  const logGroup = new cdk.aws_logs.LogGroup(scope, "restatectl-log-group", {
    retention,
  });

  const role =
    restatectlProps?.executionRole ??
    new cdk.aws_iam.Role(scope, "restatectl-lambda-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:${logGroup.logGroupName}:log-stream:*`,
      ],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaLogStreamPermissions",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:DeleteNetworkInterface",
      ],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaVPCWildcardPermissions",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: [
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
      ],
      resources: [
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:network-interface/*`,
      ],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaVPCNetworkInterfacePermissions",
    }),
  );

  const fn = new cdk.aws_lambda.Function(scope, "restatectl-lambda", {
    role,
    runtime: cdk.aws_lambda.Runtime.PROVIDED_AL2023,
    handler: "restatectl", // irrelevant
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    code,
    environment: {
      RESTATECTL_ADDRESS: address,
    },
    vpc,
    vpcSubnets,
    securityGroups,
    logGroup,
    timeout: cdk.Duration.seconds(10),
  });
  cdk.Tags.of(fn).add("Name", fn.node.path);

  return { fn, logGroup };
}

// RESTATE_NODE_NAME: task ARN
// RESTATE_LOCATION: region.availability-zone
// RESTATE_ADVERTISED_ADDRESS: container IPv4 address
// RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: 75% of container's memory limit
// RESTATE_WORKER__STORAGE__NUM_PARTITIONS_TO_SHARE_MEMORY_BUDGET: evaluate math in the string env var
const statefulEntryPointScript = String.raw`
curl --no-progress-meter $ECS_CONTAINER_METADATA_URI_V4 -o container-metadata && \
curl --no-progress-meter $ECS_CONTAINER_METADATA_URI_V4/task -o task-metadata && \
export \
  RESTATE_NODE_NAME=$(jq -r '.TaskARN' task-metadata) \
  RESTATE_LOCATION="$AWS_REGION.$(jq -r '.AvailabilityZone' task-metadata)" \
  RESTATE_ADVERTISED_ADDRESS="http://$(jq -r '.Networks[0].IPv4Addresses[0]' container-metadata):5122" \
  RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE="$(($(jq -r '.Limits.Memory' container-metadata) * 3 / 4))MiB" \
  RESTATE_WORKER__STORAGE__NUM_PARTITIONS_TO_SHARE_MEMORY_BUDGET=$(("$RESTATE_WORKER__STORAGE__NUM_PARTITIONS_TO_SHARE_MEMORY_BUDGET"))
exec restate-server
`;

const statelessEntryPointScript = String.raw`
curl --no-progress-meter $ECS_CONTAINER_METADATA_URI_V4 -o container-metadata && \
curl --no-progress-meter $ECS_CONTAINER_METADATA_URI_V4/task -o task-metadata && \
export \
  RESTATE_NODE_NAME=$(jq -r '.TaskARN' task-metadata) \
  RESTATE_LOCATION="$AWS_REGION.$(jq -r '.AvailabilityZone' task-metadata)" \
  RESTATE_ADVERTISED_ADDRESS="http://$(jq -r '.Networks[0].IPv4Addresses[0]' container-metadata):5122"
exec restate-server
`;

function validateRestateVersion(node?: NodeProps): SupportedRestateVersion {
  const restateVersion =
    node?.restateVersion ??
    (node?.restateImage ?? DEFAULT_RESTATE_IMAGE).split(":").pop();

  if (!restateVersion)
    throw new Error(
      `Could not derive the version of restate from the provided image ${node?.restateImage ?? DEFAULT_RESTATE_IMAGE}, a restateVersion parameter must be provided`,
    );

  assertSupportedRestateVersion(restateVersion);
  return restateVersion;
}

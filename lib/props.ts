import * as cdk from "aws-cdk-lib";

export interface RestateBYOCProps {
  /**
   * The name of the Restate cluster
   * Default: The path of the RestateBYOC construct is used
   */
  clusterName?: string;
  /**
   * The License ID for the BYOC product, provided to you by Restate. This ID will be used by
   * your controller to occasionally load a new License Key from https://license.restate.cloud.
   */
  licenseID: string;
  /**
   * The VPC in which to run the cluster
   */
  vpc: cdk.aws_ec2.IVpc;
  /**
   * How to choose subnets within the provided VPC. Providing no more than one subnet per AZ is recommended.
   * Default: one PRIVATE_WITH_EGRESS subnet per AZ
   */
  subnets?: cdk.aws_ec2.SubnetSelection;
  /**
   * Object storage configuration for snapshot and metadata storage
   * Default: a new bucket is created
   */
  objectStorage?: {
    bucket: cdk.aws_s3.IBucket;
    /**
     * The subpath within a bucket to store under, eg if `my-folder` we will write `my-folder/{snapshots,metadata}`
     * Default: the bucket root is used
     */
    subpath?: string;
  };
  /**
   * Security groups to apply to the NLB, the restate nodes and the restatectl lambda.
   * If provided, internal connections on 8080, 9070 and 5122 are assumed to be allowed.
   * If not provided, a suitable group will be created.
   * To allow traffic through NLBs from clients outside the security group, additional inbound rules may be needed.
   */
  securityGroups?: cdk.aws_ec2.ISecurityGroup[];
  /**
   * Configuration for the load balancer which will route to the stateless nodes.
   * Default: See the documentation for RestateBYOCLoadBalancerProps
   */
  loadBalancer?: RestateBYOCLoadBalancerProps;
  /**
   * Human-facing addresses for Restate ports
   * Default: The address of the shared load balancer on the relevant port
   */
  addresses?: {
    /**
     * Human-facing address for the ingress, used in the control panel and in the Restate UI
     */
    ingress?: string;
    /**
     * Human-facing address for the admin, used in the control panel
     */
    admin?: string;
    /**
     * Human-facing address for the Restate UI, used in the control panel
     */
    webUI?: string;
  };
  /**
   * An ECS cluster onto which to schedule tasks.
   * Default: A cluster will be created.
   */
  ecsCluster?: cdk.aws_ecs.ICluster;
  /**
   * Options for the stateless nodes, which run the http-ingress and admin roles
   * Default: See the documentation for RestateBYOCStatelessProps
   */
  statelessNode?: RestateBYOCStatelessProps;
  /**
   * Options for the stateful nodes, which run the log-server and worker roles.
   * Default: See the documentation for RestateBYOCStatefulProps
   */
  statefulNode?: RestateBYOCStatefulProps;
  /**
   * Fargate task configurables for the restate nodes
   * Defaults:
    - An execution and task role will be created by this construct
    - awsLogs log driver will be used with a `restate` stream prefix.
    - execute command is not allowed
    - ARM cpu architecture
   */
  restateTasks?: Partial<RestateBYOCTaskProps>;
  /**
   * Options for the controller
   * Default: See the documentation for RestateBYOCControllerProps
   */
  controller?: RestateBYOCControllerProps;
  /**
   * Options for the restatectl lambda
   * Default: See the documentation for RestateBYOCRestatectlProps
   */
  restatectl?: RestateBYOCRestatectlProps;
  /**
   * Options for the fargate task retirement watcher
   * Default: See the documentation for RestateBYOCRetirementWatcherProps
   */
  retirementWatcher?: RestateBYOCRetirementWatcherProps;

  /**
   * Options for monitoring
   * Default: See the documentation for RestateBYOCMonitoringProps
   */
  monitoring?: RestateBYOCMonitoringProps;

  /**
   * @internal
   *
   * Override the artifact distribution mode for development. Set this to `true` to use artifacts
   * like `restatectl` and the CloudWatch widget directly from the codebase, rather than the
   * reference the public bucket artifacts.
   */
  _useLocalArtifacts?: boolean;
}

export type LoadBalancerSource =
  | {
      /**
       * Props to configure the creation of a new NLB
       */
      nlbProps: cdk.aws_elasticloadbalancingv2.NetworkLoadBalancerProps;
    }
  | {
      /**
       * An existing NLB to use
       */
      nlb: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
    };

export interface RestateBYOCLoadBalancerProps {
  /**
   * Options for the shared load balancer which is used for internal ingress, admin, and node traffic on default ports.
   * The restatectl lambda needs access to the node port.
   * Default: An internal NLB is created in the same vpc and with the same security groups as the rest of this stack
   */
  shared?: LoadBalancerSource;

  /**
   * If set, always create ALB targets. ECS requires that the target is attached to a load balancer within the same stack as the ECS Service.
   * Default: ALB targets are created lazily when accessed via `byoc.targetGroups.{ingress,admin}.application`
   */
  createAlbTargets?: boolean;
}

export const DEFAULT_STATELESS_DESIRED_COUNT = 3;
export const DEFAULT_PARTITIONS = 128;

export interface RestateBYOCStatelessProps extends RestateBYOCNodeProps {
  /**
   * Configures the default replication factor to be used by the replicated loglets and the partition processors.
   * Note that this value only impacts the cluster initial provisioning and will not be respected after the cluster has been provisioned.
   * Default: {zone: 2}
   */
  defaultReplication?: { node: number } | { zone: number };
  /**
   * Number of partitions that will be provisioned during initial cluster provisioning. Partitions are the logical shards used to process messages.
   * Default: 128
   */
  defaultPartitions?: number;
  /**
   * The number of stateless nodes to run. These serve ingress requests and the admin API.
   * Default: 3
   */
  desiredCount?: number;
  /**
   * The address of the ingress node to advertise for use by the Restate UI.
   * Default: An address will be determined based on the configured load balancer for the ingress.
   */
  ingressAdvertisedAddress?: string;
}

export const DEFAULT_STATEFUL_NODES_PER_AZ = 1;

export interface RestateBYOCStatefulProps extends RestateBYOCNodeProps {
  /**
   * The number of stateful nodes to run per AWS availability zone.
   * Default: 1
   */
  nodesPerAz?: number;
  /**
   * Configuration for the EBS volume to attach to stateful nodes. Without an EBS volume, nodes will use 200G of the default
   * Fargate ephemeral storage, which is backed by an EBS gp2 volume (600 baseline IOPS).
   * Default: No EBS volume
   */
  ebsVolume?: RestateBYOCEBSVolumeProps;
}

export interface RestateBYOCEBSVolumeProps {
  /**
   * The type of the volume to create for each node
   * Default: The default of the CreateVolume API, currently `gp2`
   */
  volumeType?: cdk.aws_ec2.EbsDeviceVolumeType;
  /**
   * The role that will be passed to ECS in order to allow it to manage EBS volumes.
   * It must be assumable by `ecs.amazonaws.com` and either have the AWS managed policy
   * `service-role/AmazonECSInfrastructureRolePolicyForVolumes` attached, or the more minimal
   * policy specified in `VOLUME_POLICY` attached. Permissions will be given to the controller
   * to pass this role to ECS.
   * Default: A role with the appropriate permissions will be created
   */
  volumeRole?: cdk.aws_iam.IRole;
  /**
   * The size of the volume to create for each node.
   */
  sizeInGiB: number;
  /**
   * The iops to provision for each volume
   * This parameter is required for io1 and io2 volumes.
   * The default for gp3 volumes is 3,000 IOPS. This parameter is not supported for gp2, st1, sc1, or standard volumes.
   */
  iops?: number;
  /**
   * The throughput to provision for each volume
   * This parameter is valid only for gp3 volumes, where it otherwise defaults to 125.
   */
  throughput?: number;
}

export const DEFAULT_RESTATE_IMAGE =
  "docker.restate.dev/restatedev/restate:1.4";

export const DEFAULT_RESTATE_CPU = 16384;
export const DEFAULT_RESTATE_MEMORY_LIMIT_MIB = 32768;

export type SupportedRestateVersion = `1.4.${string}` | `1.4` | `1.3.2` | `1.3`;
export function assertSupportedRestateVersion(
  version: string,
): asserts version is SupportedRestateVersion {
  if (
    version == "1.3" ||
    version == "1.3.2" ||
    version == "1.4" ||
    version.startsWith("1.4.")
  )
    return;
  throw new Error(`Restate version ${version} is not supported by this stack`);
}

export interface RestateBYOCNodeProps {
  /**
   * The Restate image to use for the node
   * Default: docker.restate.dev/restatedev/restate:1.3
   */
  restateImage?: string;

  /**
   * @internal
   * Custom image to use, takes precedence over `restateImage`
   */
  _restateImage?: cdk.aws_ecs.ContainerImage;

  /**
   * The version of Restate that restateImage contains
   * Default: This will be derived from the image suffix; it must be provided if derivation failed
   */
  restateVersion?: SupportedRestateVersion;

  /**
   * The resources for the fargate task that runs the node
   * Default: 16384 CPU and 32768 memory
   */
  resources?: { cpu: number; memoryLimitMiB: number };

  /**
   * Environment properties for the `restate` container
   */
  environment?: {
    [key: string]: string;
  };
}

export const DEFAULT_CONTROLLER_IMAGE =
  "docker.restate.dev/restatedev/restate-fargate-controller:0.2";
export const DEFAULT_CONTROLLER_CPU = 1024;
export const DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB = 2048;
export const DEFAULT_CONTROLLER_SNAPSHOT_RETENTION = "24h";

/**
 * Properties for configuring the controller
 */
export interface RestateBYOCControllerProps {
  /**
   * The controller image to use
   * Default: docker.restate.dev/restatedev/restate-fargate-controller:0.1
   */
  controllerImage?: string;

  /**
   * @internal
   * Custom controller image to use, takes precedence over `controllerImage`
   */
  _controllerImage?: cdk.aws_ecs.ContainerImage;

  /**
   * The resources for the fargate task that runs the controller
   * Default: 1 vCPU and 2G memory
   */
  resources?: { cpu: number; memoryLimitMiB: number };

  /**
   * Fargate task configurables for the controller
   * Defaults:
    - An execution and task role will be created by the CDK service construct.
    - awsLogs log driver will be used with a `controller` stream prefix.
    - execute command is not allowed
    - ARM cpu architecture
   */
  tasks?: Partial<RestateBYOCTaskProps>;

  /**
   * Configuration for EBS snapshot retention
   * Default: retain volumes for 24 hours
   */
  snapshotRetention?: {
    /**
     * Disable EBS snapshot retention; volumes will be deleted on task exit
     * Default: false
     */
    disabled?: boolean;
    /**
     * The duration to retain EBS snapshots for after they are finished creating
     * Default: 24 hours
     */
    duration?: cdk.Duration;
  };
}

export interface RestateBYOCTaskProps {
  /**
   * The task execution role for the task, assumable by `ecs-tasks.amazonaws.com`
   */
  executionRole: cdk.aws_iam.IRole;
  /**
   * The task role for the task, assumable by `ecs-tasks.amazonaws.com`
   */
  taskRole: cdk.aws_iam.IRole;
  /**
   * The log driver for the task
   */
  logDriver: cdk.aws_ecs.LogDriver;
  /**
   * Whether execute-command is allowed on this task
   */
  enableExecuteCommand: boolean;
  /**
   * The CPU architecture on which to run the task
   */
  cpuArchitecture: cdk.aws_ecs.CpuArchitecture;
}

export interface RestateBYOCRestatectlProps {
  /**
   * If true, do not create a restatectl lambda. Note this lambda is also required for CloudWatch custom widgets.
   * Default: false
   */
  disabled?: boolean;
  /**
   * The execution role for the restatectl lambda, which must be assumable by lambda.amazonaws.com
   * Permissions will be added to the role to allow it to execute in a vpc and send logs to cloudwatch
   * Default: A role will be created
   */
  executionRole?: cdk.aws_iam.IRole;
}

export interface RestateBYOCRetirementWatcherProps {
  /**
   * If true, do not create a retirement watcher. This means that retirement notifications from AWS health must be handled in some other way.
   * Default: false
   */
  disabled?: boolean;
  /**
   * The execution role for the retirement watcher lambda, which must be assumable by lambda.amazonaws.com
   * Permissions will be added to the role to allow it to send logs to cloudwatch
   * Default: A role will be created
   */
  executionRole?: cdk.aws_iam.IRole;
}

export const DEFAULT_OTEL_COLLECTOR_IMAGE =
  "public.ecr.aws/aws-observability/aws-otel-collector:latest";
export const DEFAULT_OTEL_COLLECTOR_CPU = 256;
export const DEFAULT_OTEL_COLLECTOR_MEMORY_LIMIT_MIB = 512;

export interface RestateBYOCOtelCollectorProps {
  /**
   * If true, create OTEL collector sidecars for telemetry collection.
   * Default: false
   */
  enabled: true;

  /**
   * Options to configure Restate's OTEL trace sampling
   * Default: Restate will not send OTEL traces to the collector
   */
  traceOptions?:
    | {
        /**
         * The type of the sampler
         * always_off - never sample
         * always_on - always sample
         * parentbased_always_on - always sample unless the parent was not sampled
         * parentbased_always_off - never sample unless the parent was sampled
         */
        sampler:
          | "always_off" //
          | "always_on"
          | "parentbased_always_on"
          | "parentbased_always_off";
      }
    | {
        /**
         * The type of the sampler
         * traceidratio - sample a proportion of traces given by samplerArg
         * parentbased_traceidratio - recommended. sample if the parent was sampled, otherwise sample a proportion of traces given by samplerArg
         */
        sampler: "traceidratio" | "parentbased_traceidratio";
        /**
         * The sampling ratio, as a number between 0 and 1
         */
        samplerArg: string;
      };

  /**
   * The OTEL collector image to use
   * Default: public.ecr.aws/aws-observability/aws-otel-collector:latest
   */
  image?: string;

  /**
   * The resources for the OTEL collector sidecar container
   * Default: 256 CPU and 512 memory
   */
  resources?: { cpu: number; memoryLimitMiB: number };

  /**
   * The health check for the OTEL collector sidecar container
   * Set to null to disable health checking
   * Default: /healthcheck command
   */
  healthCheck?: cdk.aws_ecs.HealthCheck | null;

  /**
   * The secret environment variables to pass to the container.
   *
   * Default: No secret environment variables.
   */
  secrets?: { [key: string]: cdk.aws_ecs.Secret };

  /**
   * Configuration for the OTEL collector
   */
  configuration:
    | {
        /**
         * How often to collect metrics from Restate
         */
        restateScrapeInterval?: cdk.Duration;

        /**
         * How often to collect metrics from ECS
         */
        ecsCollectionInterval?: cdk.Duration;

        /**
         * Exporter definitions, indexed by their ID
         * eg: {awsemf: {namespace: 'Restate/Metrics', log_group_name: '/restate/metrics'}}
         * Do not include secrets directly here; instead refer to env vars like ${env:MY_SECRET}
         * and add the appropriate environment variables to the secrets field.
         */
        exporters: {
          [id: string]: object;
        };

        /**
         * Exporter IDs
         */
        traceExporterIds?: string[];

        /**
         * Destination endpoints for metrics and traces
         */
        metricExporterIds?: string[];
      }
    | {
        /**
         * Custom OTEL collector configuration YAML
         * If provided, this will override the default configuration
         * Please ensure that service.extensions includes health_check, or disable the health check above.
         * Do not include secrets directly here; instead refer to env vars like ${env:MY_SECRET}
         * and add the appropriate environment variables to the secrets field.
         */
        customConfig: string;
      };
}

export interface RestateBYOCMonitoringProps {
  dashboard?: {
    metrics?: {
      /**
       * If true, do not create a CloudWatch dashboard for metrics.
       * Default: false
       */
      disabled?: boolean;

      /**
       * If true, use the cdk autogenerated name instead of the default dashboard name
       * Default: false
       */
      autogeneratedName?: boolean;
    };

    controlPanel?: {
      /**
       * If true, do not create a CloudWatch control panel dashboard.
       * Default: false
       */
      disabled?: boolean;

      /**
       * If true, use the cdk autogenerated name instead of the default dashboard name
       * Default: false
       */
      autogeneratedName?: boolean;
    };

    customWidgets?: {
      /**
       * If true, do not create CloudWatch custom widgets and their associated Lambda.
       * This is required for the control panel dashboard, and for volume IOPS graphs on the metrics dashboard.
       * Default: false
       */
      disabled?: boolean;

      /**
       * The execution role for the CloudWatch custom widget lambda, which must be assumable by lambda.amazonaws.com
       * Necessary permissions will be added to the role
       * Default: A role will be created
       */
      executionRole?: cdk.aws_iam.IRole;
    };
  };

  /**
   * Options for OpenTelemetry collector sidecars
   * Default: OTEL collector sidecars are disabled
   */
  otelCollector?: RestateBYOCOtelCollectorProps;
}

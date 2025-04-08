import * as cdk from "aws-cdk-lib";

export interface RestateBYOCProps {
  /**
   * The VPC in which to run the cluster
   */
  vpc: cdk.aws_ec2.IVpc;
  /**
   * How to choose subnets within the provided VPC
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
   * To allow traffic through the NLB from clients outside the security group, additional inbound rules will be needed.
   */
  securityGroups?: cdk.aws_ec2.ISecurityGroup[];
  /**
   * Configuration for the NLB which will route to the stateless nodes.
   * Default: An NLB will be created with no SSL configuration
   */
  loadBalancer?: RestateBYOCLoadBalancerProps;
  /**
   * An ECS cluster onto which to schedule tasks.
   * Default: A cluster will be created.
   */
  cluster?: cdk.aws_ecs.ICluster;
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
}

export interface RestateBYOCLoadBalancerProps {
  /**
   * An NLB on which to add target groups and listeners for Restate
   * Default: An NLB will be created
   */
  nlb?: cdk.aws_elasticloadbalancingv2.INetworkLoadBalancer;
  /**
   * SSL configuration for the NLB listeners
   * Default: SSL will not be used
   */
  ssl?: {
    /**
     * Listener certificate for the listeners
     */
    listenerCertificate: cdk.aws_elasticloadbalancingv2.IListenerCertificate;
    /**
     * The SSL policy for the listeners
     * Default: the CDK default SSL policy
     */
    sslPolicy?: cdk.aws_elasticloadbalancingv2.SslPolicy;
  };
}

export interface RestateBYOCStatelessProps extends RestateBYOCNodeProps {
  /**
   * Configures the default replication factor to be used by the replicated loglets.
   * Note that this value only impacts the cluster initial provisioning and will not be respected after the cluster has been provisioned.
   * Default: {zone: 2}
   */
  defaultLogReplication?: { node: number } | { zone: number };
  /**
   * The default replication factor for partition processors, this impacts how many replicas each partition will have across the worker nodes of the cluster.
   * Note that this value only impacts the cluster initial provisioning and will not be respected after the cluster has been provisioned.
   * Default: everywhere
   */
  defaultPartitionReplication?: { node: number } | "everywhere";
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
}

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
   * Default: The default for the volume type
   */
  iops?: number;
  /**
   * The throughput to provision for each volume
   * Default: The default for the volume type
   */
  throughput?: number;
}

export const DEFAULT_RESTATE_IMAGE =
  "docker.restate.dev/restatedev/restate:1.3";

export interface RestateBYOCNodeProps {
  /**
   * The Restate image to use for the node
   * Default: docker.restate.dev/restatedev/restate:1.3
   */
  restateImage?: string;
  /**
   * The resources for the fargate task that runs the node
   * Default: 16 vCPU and 32G memory
   */
  resources?: { cpu: number; memoryLimitMiB: number };
}

export interface RestateBYOCControllerProps {
  /**
   * The path to a docker image tarball containing the controller
   * Default: controller.tar in the root of the cdk project
   */
  controllerImageTarball?: string;
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
   * If true, do not create a restatectl lambda
   * Default: false
   */
  disabled?: boolean;
  /**
   * The execution role for the retstatectl lambda, which must be assumable by lambda.amazonaws.com
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

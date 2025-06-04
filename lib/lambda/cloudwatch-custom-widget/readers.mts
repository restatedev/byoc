import * as ecs from "@aws-sdk/client-ecs";
import * as ec2 from "@aws-sdk/client-ec2";
import * as cloudwatch from "@aws-sdk/client-cloudwatch";
import * as lambda from "@aws-sdk/client-lambda";
import type {
  ControlPanelProps,
  LogInfo,
  PartitionInfo,
  StatefulTaskProps,
  StatelessTaskProps,
  TaskProps,
  Volume,
} from "./control-panel.mjs";

export interface ControlPanelInput {
  region: string;
  summary: {
    clusterName: string;
    restateVersion: string;
    stackVersion: string;
    metricsDashboardName?: string;
  };
  resources: {
    ecsClusterArn: string;
    statelessServiceArn: string;
    controllerServiceArn: string;
    restatectlLambdaArn: string;
  };
  connectivityAndSecurity: {
    connectivity: {
      loadBalancerArns: {
        ingress: string[];
        admin: string[];
      };
      addresses: {
        ingress?: string;
        admin?: string;
        webUI?: string;
      };
    };
    networking: {
      vpc: string;
      availabilityZones: string[];
      subnets: string[];
    };
    security: {
      securityGroups: string[];
      certificateArn?: string;
    };
  };
  storage: {
    s3: {
      bucket: string;
    };
  };
}

const controllerTaskDefinitionArnPattern =
  /^CONTROLLER_ECS_CLUSTERS__[^_]+__ZONES__[^_]+__TASK_DEFINITION_ARN$/;
const controllerTaskCountPattern =
  /^CONTROLLER_ECS_CLUSTERS__[^_]+__ZONES__[^_]+__COUNT$/;
const pendingStatuses = new Set(["PROVISIONING", "PENDING", "ACTIVATING"]);

export async function getControlPanel(
  input: ControlPanelInput,
): Promise<ControlPanelProps> {
  // ListTasks scoped to ecs:cluster
  // DescribeTasks scoped to ecs:cluster
  // DescribeTaskDefinition on *
  // DescribeServices on controller and stateless services
  const ecsClient = new ecs.ECSClient({ region: input.region });
  // DescribeVolumes on *
  // DescribeVolumeStatus on *
  const ec2Client = new ec2.EC2Client({ region: input.region });
  // GetMetricData on *
  const cloudwatchClient = new cloudwatch.CloudWatchClient({
    region: input.region,
  });
  // InvokeFunction on the restatectl lambda arn
  const lambdaClient = new lambda.LambdaClient({
    region: input.region,
  });

  const ecsClusterName = input.resources.ecsClusterArn.split("/").pop()!;

  const servicesDescribe = describeServices(ecsClient, ecsClusterName, [
    input.resources.statelessServiceArn,
    input.resources.controllerServiceArn,
  ]);

  const statelessServiceDescribe = servicesDescribe.then(
    (servicesDescribe) => servicesDescribe[input.resources.statelessServiceArn],
  );
  const controllerServiceDescribe = servicesDescribe.then(
    (servicesDescribe) =>
      servicesDescribe[input.resources.controllerServiceArn],
  );

  const statelessTaskDefinition = statelessServiceDescribe.then(
    (statelessServiceDescribe) =>
      describeTaskDefinition(
        ecsClient,
        statelessServiceDescribe.taskDefinition!,
      ),
  );

  const controllerTaskDefinition = controllerServiceDescribe.then(
    (controllerServiceDescribe) =>
      describeTaskDefinition(
        ecsClient,
        controllerServiceDescribe.taskDefinition!,
      ),
  );

  const statelessContainerDefinition = statelessTaskDefinition.then(
    (statelessTaskDefinition) =>
      statelessTaskDefinition.containerDefinitions?.find(
        (container) => container.name == "restate",
      ),
  );

  const controllerContainerDefinition = controllerTaskDefinition.then(
    (controllerTaskDefinition) =>
      controllerTaskDefinition.containerDefinitions?.find(
        (container) => container.name == "controller",
      ),
  );

  const statefulDesiredCount = controllerContainerDefinition.then(
    (controllerContainerDefinition) =>
      controllerContainerDefinition?.environment
        ?.filter((env) =>
          env.name ? controllerTaskCountPattern.test(env.name) : false,
        )
        .reduce((count, env) => {
          const num = Number(env.value);
          return Number.isNaN(num) ? count : count + num;
        }, 0),
  );

  const statefulTaskDefinition = controllerContainerDefinition.then(
    async (controllerContainerDefinition) => {
      const statefulTaskDefinition =
        controllerContainerDefinition?.environment?.find((env) =>
          env.name ? controllerTaskDefinitionArnPattern.test(env.name) : false,
        )?.value;

      if (!statefulTaskDefinition)
        throw new Error(
          "Missing stateful task definition in controller environment variables",
        );

      return describeTaskDefinition(ecsClient, statefulTaskDefinition);
    },
  );

  const statefulContainerDefinition = statefulTaskDefinition.then(
    (statefulTaskDefinition) =>
      statefulTaskDefinition?.containerDefinitions?.find(
        (container) => container.name == "restate",
      ),
  );

  const [statelessServiceName, controllerServiceName] = [
    input.resources.statelessServiceArn.split("/").pop()!,
    input.resources.controllerServiceArn.split("/").pop()!,
  ];

  const tasks = describeTasks(
    ecsClient,
    input.resources.ecsClusterArn,
    statelessServiceName,
    controllerServiceName,
  );

  const pendingStatefulTasks = tasks.then(
    (tasks) =>
      tasks.statefulTasks.filter(
        (statefulTask) =>
          statefulTask.lastStatus &&
          pendingStatuses.has(statefulTask.lastStatus),
      ).length,
  );
  const runningStatefulTasks = tasks.then((tasks) =>
    tasks.statefulTasks.filter(
      (statefulTask) => statefulTask.lastStatus == "RUNNING",
    ),
  );

  const volumeInfo = tasks.then((tasks) => {
    const ebsVolumeIds: string[] = [];
    const taskArnByVolumeId = new Map<string, string>();
    const ephemeralVolumes: Volume[] = [];

    const ebsTaskFamilies: Set<string> = new Set();
    const ephemeralTaskFamilies: Set<string> = new Set();
    tasks.statefulTasks.forEach((statefulTask) => {
      if (!statefulTask.taskArn) return;
      if (!statefulTask.group?.startsWith("family:")) return;
      const taskFamily = statefulTask.group.slice("family:".length);

      // avoid reading volumes of stopped tasks
      if (statefulTask.lastStatus !== "RUNNING") return;

      const volumeID = statefulTask.attachments
        ?.find((attachment) => attachment.type == "AmazonElasticBlockStorage")
        ?.details?.find((detail) => detail.name == "volumeId")?.value;

      if (volumeID) {
        ebsVolumeIds.push(volumeID);
        taskArnByVolumeId.set(volumeID, statefulTask.taskArn!);
        ebsTaskFamilies.add(taskFamily);
      } else if (statefulTask.fargateEphemeralStorage?.sizeInGiB) {
        ephemeralVolumes.push({
          taskArn: statefulTask.taskArn!,
          availabilityZone: statefulTask.availabilityZone!,
          type: "gp2",
          iops: 600,
          throughput: 125,
          sizeInGiB: statefulTask.fargateEphemeralStorage.sizeInGiB,
          state: "in-use",
          statusCheck: "not-available",
        });
        ephemeralTaskFamilies.add(taskFamily);
      }
    });

    const ebsVolumesDescribe =
      ebsVolumeIds.length > 0
        ? ec2Client
            .send(
              new ec2.DescribeVolumesCommand({
                VolumeIds: ebsVolumeIds,
              }),
            )
            .then((describe) => describe.Volumes ?? [])
        : Promise.resolve([] as ec2.Volume[]);

    const ebsVolumesStatus =
      ebsVolumeIds.length > 0
        ? ec2Client
            .send(
              new ec2.DescribeVolumeStatusCommand({
                VolumeIds: ebsVolumeIds,
              }),
            )
            .then((describe) => describe.VolumeStatuses ?? [])
        : Promise.resolve([] as ec2.VolumeStatusItem[]);

    const ebsVolumes: Promise<Volume[]> = Promise.all([
      ebsVolumesDescribe,
      ebsVolumesStatus,
    ]).then(([ebsVolumesDescribe, ebsVolumesStatus]) => {
      return ebsVolumesDescribe.map((volume) => {
        const { iopsLimit, throughputLimit } = volumeLimits(volume);

        return {
          taskArn: taskArnByVolumeId.get(volume.VolumeId!)!,
          volumeID: volume.VolumeId!,
          availabilityZone: volume.AvailabilityZone!,
          type: volume.VolumeType!,
          sizeInGiB: volume.Size!,
          iops: iopsLimit,
          throughput: throughputLimit,
          state: volume.State!,
          statusCheck:
            ebsVolumesStatus.find(
              (volumeStatus) => volumeStatus.VolumeId == volume.VolumeId,
            )?.VolumeStatus?.Status ?? "not-available",
        } satisfies Volume;
      });
    });

    return {
      ebsVolumes,
      ephemeralVolumes,
      ebsTaskFamilies,
      ephemeralTaskFamilies,
    };
  });

  const volumes = volumeInfo.then(async (volumeInfo) => [
    ...(await volumeInfo.ebsVolumes),
    ...volumeInfo.ephemeralVolumes,
  ]);

  const minuteMetrics = volumeInfo.then(
    ({ ebsTaskFamilies, ephemeralTaskFamilies }) =>
      getMinutelyMetrics(
        cloudwatchClient,
        ecsClusterName,
        ebsTaskFamilies,
        ephemeralTaskFamilies,
      ),
  );
  const cpu = minuteMetrics.then((metric) =>
    metric.cpuSizeMetric?.Values?.[0] && metric.cpuUtilMetric?.Values?.[0]
      ? (100 * metric.cpuUtilMetric.Values[0]) / metric.cpuSizeMetric.Values[0]
      : undefined,
  );
  const memory = minuteMetrics.then((metric) =>
    metric.memorySizeMetric?.Values?.[0] && metric.memoryUtilMetric?.Values?.[0]
      ? (100 * metric.memoryUtilMetric.Values[0]) /
        metric.memorySizeMetric.Values[0]
      : undefined,
  );
  const storagePercent = minuteMetrics.then((metric) =>
    metric.storageSizeMetric?.Values?.[0] &&
    metric.storageUtilMetric?.Values?.[0]
      ? (100 * metric.storageUtilMetric.Values[0]) /
        metric.storageSizeMetric.Values[0]
      : undefined,
  );

  const status = controllerServiceDescribe.then((controllerServiceDescribe) =>
    getStatus(controllerServiceDescribe),
  );

  const dailyMetrics = getDailyMetrics(
    cloudwatchClient,
    input.storage.s3.bucket,
    input.connectivityAndSecurity.security.certificateArn,
  );
  const s3BucketSize = dailyMetrics.then((dailyMetrics) => {
    if (!dailyMetrics.s3BucketSizeMetric?.Values?.[0]) {
      return undefined;
    }
    return formatBytes(dailyMetrics.s3BucketSizeMetric.Values[0]);
  });
  const s3BucketCount = dailyMetrics.then(
    (dailyMetrics) => dailyMetrics.s3BucketCountMetric?.Values?.[0],
  );
  const certificateExpiry = dailyMetrics.then((dailyMetrics) => {
    if (
      !dailyMetrics.daysToExpiryMetric?.Values?.[0] ||
      !dailyMetrics.daysToExpiryMetric?.Timestamps?.[0]
    ) {
      return undefined;
    }
    const expiry = dailyMetrics.daysToExpiryMetric.Timestamps[0];
    expiry.setDate(
      expiry.getDate() + dailyMetrics.daysToExpiryMetric.Values[0],
    );
    return expiry.toDateString();
  });

  const logGroup = (containerDefinition?: ecs.ContainerDefinition) => {
    return containerDefinition?.logConfiguration?.logDriver == "awslogs"
      ? containerDefinition?.logConfiguration?.options?.["awslogs-group"]
      : undefined;
  };

  const nodesConfig = getNodesConfig(
    lambdaClient,
    input.resources.restatectlLambdaArn,
  );
  const nodeState = restatectlSql(
    lambdaClient,
    input.resources.restatectlLambdaArn,
    "select * from node_state",
  );
  const bifrostConfig = getBifrostConfig(
    lambdaClient,
    input.resources.restatectlLambdaArn,
  );
  const partitionTable = getPartitionTable(
    lambdaClient,
    input.resources.restatectlLambdaArn,
  );
  const licenseKeyOrg = getLicenseKeyOrg(
    lambdaClient,
    input.resources.restatectlLambdaArn,
  );
  const partitionState = restatectlSql(
    lambdaClient,
    input.resources.restatectlLambdaArn,
    "select * from partition_state order by PARTITION_ID asc, EFFECTIVE_MODE desc, PLAIN_NODE_ID asc",
  );

  const nodes = Promise.all([
    nodesConfig,
    nodeState,
    bifrostConfig,
    partitionTable,
    tasks,
    volumes,
  ]).then(
    ([nodesConfig, nodeState, bifrostConfig, partitionTable, tasks, volumes]) =>
      getNodes(
        nodesConfig,
        nodeState,
        bifrostConfig,
        partitionTable,
        tasks.statelessTasks,
        tasks.statefulTasks,
        volumes,
      ),
  );
  const statefulNodes = nodes.then((nodes) => nodes.statefulNodes);
  const statelessNodes = nodes.then((nodes) => nodes.statelessNodes);
  const controllerTasks = tasks.then((tasks) =>
    tasks.controllerTasks
      .filter((task) => task.lastStatus != "STOPPED")
      .map(
        (task) =>
          ({
            taskID: task.taskArn!.split("/").pop()!,
            availabilityZone: task.availabilityZone ?? "N/A",
            lastStatus: task.lastStatus ?? "UNKNOWN",
            desiredStatus: task.desiredStatus ?? "UNKNOWN",
            taskDefinition: task.taskDefinitionArn,
            healthStatus: task.healthStatus ?? "UNKNOWN",
            cpu: task.cpu!,
            memory: task.memory!,
            startedAt: task.startedAt?.toISOString() ?? "Not Started",
          }) satisfies TaskProps,
      ),
  );

  const logs = bifrostConfig.then(getLogs);

  const partitions = Promise.all([partitionTable, partitionState]).then(
    ([partitionTable, partitionState]) =>
      getPartitions(partitionTable, partitionState),
  );

  return {
    summary: {
      clusterName: input.summary.clusterName,
      licensedTo: await licenseKeyOrg,
      usage: {
        cpuPercent: await cpu,
        memoryPercent: await memory,
        storagePercent: await storagePercent,
      },
      status: await status,
      restateVersion: input.summary.restateVersion,
      stackVersion: input.summary.stackVersion,
      metricsDashboardName: input.summary.metricsDashboardName,
      tasks: {
        stateless: {
          desired: (await statelessServiceDescribe).desiredCount ?? 0,
          pending: (await statelessServiceDescribe).pendingCount ?? 0,
          running: (await statelessServiceDescribe).runningCount ?? 0,
        },
        stateful: {
          desired: (await statefulDesiredCount) ?? 0,
          pending: await pendingStatefulTasks,
          running: (await runningStatefulTasks).length,
        },
        controller: {
          desired: (await controllerServiceDescribe).desiredCount ?? 0,
          pending: (await controllerServiceDescribe).pendingCount ?? 0,
          running: (await controllerServiceDescribe).runningCount ?? 0,
        },
      },
    },
    connectivityAndSecurity: {
      region: input.region,
      connectivity: {
        loadBalancerArns: [
          ...new Set([
            ...input.connectivityAndSecurity.connectivity.loadBalancerArns
              .ingress,
            ...input.connectivityAndSecurity.connectivity.loadBalancerArns
              .admin,
          ]),
        ].sort(),
        addresses: {
          ingress: input.connectivityAndSecurity.connectivity.addresses.ingress,
          admin: input.connectivityAndSecurity.connectivity.addresses.admin,
          webUI: input.connectivityAndSecurity.connectivity.addresses.webUI,
        },
      },
      networking: {
        vpc: input.connectivityAndSecurity.networking.vpc,
        availabilityZones:
          input.connectivityAndSecurity.networking.availabilityZones,
        subnets: input.connectivityAndSecurity.networking.subnets,
      },
      security: {
        securityGroups: input.connectivityAndSecurity.security.securityGroups,
        certificate: input.connectivityAndSecurity.security.certificateArn
          ? {
              id: input.connectivityAndSecurity.security.certificateArn
                .split("/")
                .pop()!,
              expiry: await certificateExpiry,
            }
          : undefined,
      },
      identity: {
        restate: {
          taskRole: (await statelessTaskDefinition)
            .taskRoleArn!.split("/")
            .pop()!,
          taskExecutionRole: (await statelessTaskDefinition)
            .executionRoleArn!.split("/")
            .pop()!,
        },
      },
    },
    nodes: {
      clusterName: input.resources.ecsClusterArn.split("/").pop()!,
      stateful: {
        logGroup: await statefulContainerDefinition.then(logGroup),
        tasks: await statefulNodes,
      },
      stateless: {
        serviceName: statelessServiceName,
        logGroup: await statelessContainerDefinition.then(logGroup),
        tasks: await statelessNodes,
      },
      controller: {
        serviceName: controllerServiceName,
        logGroup: await controllerContainerDefinition.then(logGroup),
        tasks: await controllerTasks,
      },
    },
    storage: {
      s3: {
        bucket: input.storage.s3.bucket,
        totalSize: await s3BucketSize,
        objectCount: await s3BucketCount,
      },
      volumes: await volumes,
    },
    replication: {
      logs: await logs,
      partitions: await partitions,
    },
  };
}

async function describeServices<T extends string>(
  ecsClient: ecs.ECSClient,
  ecsClusterArn: string,
  serviceArns: T[],
): Promise<{ [K in T]: ecs.Service }> {
  const describeServicesResponse = await ecsClient.send(
    new ecs.DescribeServicesCommand({
      cluster: ecsClusterArn,
      services: serviceArns,
    }),
  );
  if (describeServicesResponse.failures?.length)
    throw new Error(
      `DescribeServices returned a failure: ${describeServicesResponse.failures}`,
    );

  const entries = serviceArns.map((serviceArn) => {
    const serviceDescribe = describeServicesResponse.services?.find(
      (service) => service.serviceArn == serviceArn,
    );
    if (!serviceDescribe)
      throw new Error(
        `DescribeServices did not return a service for ${serviceArn}`,
      );

    return [serviceArn, serviceDescribe];
  });

  return Object.fromEntries(entries);
}

async function describeTaskDefinition(
  ecsClient: ecs.ECSClient,
  taskDefinition: string,
): Promise<ecs.TaskDefinition> {
  const describeTaskDefinitionResponse = await ecsClient.send(
    new ecs.DescribeTaskDefinitionCommand({
      taskDefinition,
    }),
  );

  return describeTaskDefinitionResponse.taskDefinition!;
}

async function getDailyMetrics(
  cloudwatchClient: cloudwatch.CloudWatchClient,
  s3BucketName: string,
  certificateArn?: string,
) {
  const s3Metrics: cloudwatch.MetricDataQuery[] = [
    {
      Id: `s3BucketSize`,
      MetricStat: {
        Period: 3600,
        Stat: "Average",
        Metric: {
          Namespace: "AWS/S3",
          MetricName: "BucketSizeBytes",
          Dimensions: [
            {
              Name: "BucketName",
              Value: s3BucketName,
            },
            {
              Name: "StorageType",
              Value: "StandardStorage",
            },
          ],
        },
      },
    },
    {
      Id: `s3BucketCount`,
      MetricStat: {
        Stat: "Average",
        Period: 3600,
        Metric: {
          Namespace: "AWS/S3",
          MetricName: "NumberOfObjects",
          Dimensions: [
            {
              Name: "BucketName",
              Value: s3BucketName,
            },
            {
              Name: "StorageType",
              Value: "AllStorageTypes",
            },
          ],
        },
      },
    },
  ];

  const certificateMetrics: cloudwatch.MetricDataQuery[] = certificateArn
    ? [
        {
          Id: `daysToExpiry`,
          MetricStat: {
            Stat: "Average",
            Period: 3600,
            Metric: {
              Namespace: "AWS/CertificateManager",
              MetricName: "DaysToExpiry",
              Dimensions: [
                {
                  Name: "CertificateArn",
                  Value: certificateArn,
                },
              ],
            },
          },
        },
      ]
    : [];

  const metricsResponse = await cloudwatchClient.send(
    new cloudwatch.GetMetricDataCommand({
      StartTime: new Date(new Date().valueOf() - 259200_000), // 72 hours ago
      EndTime: new Date(),
      MetricDataQueries: [...s3Metrics, ...certificateMetrics],
    }),
  );

  const s3BucketSizeMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "s3BucketSize",
  );
  const s3BucketCountMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "s3BucketCount",
  );
  const daysToExpiryMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "daysToExpiry",
  );
  return { s3BucketSizeMetric, s3BucketCountMetric, daysToExpiryMetric };
}

async function getMinutelyMetrics(
  cloudwatchClient: cloudwatch.CloudWatchClient,
  ecsClusterName: string,
  ebsTaskFamilies: Set<string>,
  ephemeralTaskFamilies: Set<string>,
) {
  const cpuMemoryMetrics: cloudwatch.MetricDataQuery[] = [
    {
      Id: "cpuutil",
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "CpuUtilized",
          Dimensions: [{ Name: "ClusterName", Value: ecsClusterName }],
        },
      },
    },
    {
      Id: "cpusize",
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "CpuReserved",
          Dimensions: [{ Name: "ClusterName", Value: ecsClusterName }],
        },
      },
    },
    {
      Id: "memoryutil",
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "MemoryUtilized",
          Dimensions: [{ Name: "ClusterName", Value: ecsClusterName }],
        },
      },
    },
    {
      Id: "memorysize",
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "MemoryReserved",
          Dimensions: [{ Name: "ClusterName", Value: ecsClusterName }],
        },
      },
    },
  ];

  const ebsSizeMetrics: cloudwatch.MetricDataQuery[] = [
    ...ebsTaskFamilies,
  ].flatMap((ebsTaskFamily, i) => [
    {
      Id: `ebssize${i}`,
      ReturnData: false,
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "EBSFilesystemSize",
          Dimensions: [
            { Name: "ClusterName", Value: ecsClusterName },
            { Name: "TaskDefinitionFamily", Value: ebsTaskFamily },
          ],
        },
      },
    },
  ]);
  const ebsUtilMetrics: cloudwatch.MetricDataQuery[] = [
    ...ebsTaskFamilies,
  ].flatMap((ebsTaskFamily, i) => [
    {
      Id: `ebsutil${i}`,
      ReturnData: false,
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "EBSFilesystemUtilized",
          Dimensions: [
            { Name: "ClusterName", Value: ecsClusterName },
            { Name: "TaskDefinitionFamily", Value: ebsTaskFamily },
          ],
        },
      },
    },
  ]);

  const ephemeralSizeMetrics: cloudwatch.MetricDataQuery[] = [
    ...ephemeralTaskFamilies,
  ].flatMap((ebsTaskFamily, i) => [
    {
      Id: `ephsize${i}`,
      ReturnData: false,
      MetricStat: {
        Stat: "Sum",
        Period: 60,
        Metric: {
          Namespace: "ECS/ContainerInsights",
          MetricName: "EphemeralStorageReserved",
          Dimensions: [
            { Name: "ClusterName", Value: ecsClusterName },
            { Name: "TaskDefinitionFamily", Value: ebsTaskFamily },
          ],
        },
      },
    },
  ]);

  const ephemeralUtilMetrics: cloudwatch.MetricDataQuery[] = [
    ...ephemeralTaskFamilies,
  ].flatMap(
    (ebsTaskFamily, i) =>
      [
        {
          Id: `ephutil${i}`,
          ReturnData: false,
          MetricStat: {
            Stat: "Sum",
            Period: 60,
            Metric: {
              Namespace: "ECS/ContainerInsights",
              MetricName: "EphemeralStorageUtilized",
              Dimensions: [
                { Name: "ClusterName", Value: ecsClusterName },
                { Name: "TaskDefinitionFamily", Value: ebsTaskFamily },
              ],
            },
          },
        },
      ] satisfies cloudwatch.MetricDataQuery[],
  );

  const totalStorageMetrics: cloudwatch.MetricDataQuery[] = [
    {
      Id: `totalstoragesize`,
      Expression:
        ebsUtilMetrics.length > 0 || ephemeralUtilMetrics.length > 0
          ? [
              ...ebsSizeMetrics.map((metric) => metric.Id),
              ...ephemeralSizeMetrics.map((metric) => metric.Id),
            ].join(" + ")
          : "TIME_SERIES(0)",
    },
    {
      Id: `totalstorageutil`,
      Expression:
        ebsUtilMetrics.length > 0 || ephemeralUtilMetrics.length > 0
          ? [
              ...ebsUtilMetrics.map((metric) => metric.Id),
              ...ephemeralUtilMetrics.map((metric) => metric.Id),
            ].join(" + ")
          : "TIME_SERIES(0)",
    },
  ];

  const metricsResponse = await cloudwatchClient.send(
    new cloudwatch.GetMetricDataCommand({
      StartTime: new Date(new Date().valueOf() - 360_000), // 6 minutes ago
      EndTime: new Date(new Date().valueOf() - 120_000), // 2 minutes ago, so that we don't see any half-full sums for cpu/memory
      MetricDataQueries: [
        ...cpuMemoryMetrics,
        ...ebsSizeMetrics,
        ...ebsUtilMetrics,
        ...ephemeralSizeMetrics,
        ...ephemeralUtilMetrics,
        ...totalStorageMetrics,
      ],
    }),
  );

  // console.log(JSON.stringify(metricsResponse));

  const cpuSizeMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "cpusize",
  );
  const cpuUtilMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "cpuutil",
  );
  const memorySizeMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "memorysize",
  );
  const memoryUtilMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "memoryutil",
  );
  const storageSizeMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "totalstoragesize",
  );
  const storageUtilMetric = metricsResponse.MetricDataResults?.find(
    (data) => data.Id == "totalstorageutil",
  );

  return {
    cpuSizeMetric,
    cpuUtilMetric,
    memorySizeMetric,
    memoryUtilMetric,
    storageSizeMetric,
    storageUtilMetric,
  };
}

function getStatus(controllerServiceDescribe: ecs.Service) {
  // sort deployments in ascending time order
  controllerServiceDescribe.deployments?.sort((a, b) => {
    if (a.createdAt === undefined && b.createdAt === undefined) return 0;
    if (b.createdAt === undefined) return 1;
    if (a.createdAt === undefined) return -1;

    return a.createdAt.valueOf() - b.createdAt.valueOf();
  });

  const latestDeployment =
    controllerServiceDescribe.deployments?.[
      controllerServiceDescribe.deployments.length - 1
    ];
  if (!latestDeployment) return "Unknown";

  switch (latestDeployment.rolloutState) {
    case "IN_PROGRESS":
      return "Deploying";
    case "FAILED":
      return "Failed";
    case "COMPLETED":
      return "Active";
    default:
      return "Unknown";
  }
}

async function describeTasks(
  ecsClient: ecs.ECSClient,
  ecsClusterArn: string,
  statelessServiceName: string,
  controllerServiceName: string,
): Promise<{
  statelessTasks: ecs.Task[];
  statefulTasks: ecs.Task[];
  controllerTasks: ecs.Task[];
}> {
  const runningTasksPaginator = ecs.paginateListTasks(
    {
      client: ecsClient,
      pageSize: 95,
    },
    {
      cluster: ecsClusterArn,
      desiredStatus: "RUNNING",
    },
  );

  const stoppedTasksPaginator = ecs.paginateListTasks(
    {
      client: ecsClient,
      pageSize: 95,
    },
    {
      cluster: ecsClusterArn,
      desiredStatus: "STOPPED",
    },
  );

  const taskPages: ecs.ListTasksCommandOutput[] = [];

  await Promise.all([
    (async () => {
      for await (const page of stoppedTasksPaginator) {
        taskPages.push(page);
      }
    })(),
    (async () => {
      for await (const page of runningTasksPaginator) {
        taskPages.push(page);
      }
    })(),
  ]);

  const tasks = taskPages.flatMap((page) => page.taskArns ?? []);

  const taskDescriptionPromises = [];
  for (let i = 0; i < tasks.length; i += 95) {
    taskDescriptionPromises.push(
      ecsClient.send(
        new ecs.DescribeTasksCommand({
          cluster: ecsClusterArn,
          tasks: tasks.slice(i, i + 95),
        }),
      ),
    );
  }

  const tasksDescriptionResponses = await Promise.all(taskDescriptionPromises);

  for (const tasksDescriptionResponse of tasksDescriptionResponses) {
    const failures = tasksDescriptionResponse.failures?.filter(
      // we allow missing, perhaps the task deleted since we made the list call.
      (failure) => failure.reason != "MISSING",
    );
    if (failures?.length)
      throw new Error(`DescribeTasks returned a failure: ${failures}`);
  }

  const taskDescriptions = tasksDescriptionResponses.flatMap(
    (tasksDescriptionResponse) => tasksDescriptionResponse.tasks ?? [],
  );

  const statelessTasks: ecs.Task[] = [];
  const statefulTasks: ecs.Task[] = [];
  const controllerTasks: ecs.Task[] = [];

  taskDescriptions.forEach((taskDescription) => {
    if (taskDescription.group == `service:${statelessServiceName}`) {
      statelessTasks.push(taskDescription);
      return;
    }

    if (taskDescription.startedBy?.startsWith("stateful/")) {
      statefulTasks.push(taskDescription);
      return;
    }

    if (taskDescription.group == `service:${controllerServiceName}`) {
      controllerTasks.push(taskDescription);
      return;
    }
  });

  return { statelessTasks, statefulTasks, controllerTasks };
}

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = parseFloat((bytes / Math.pow(k, i)).toFixed(decimals));

  return `${value} ${sizes[i]}`;
}

function volumeLimits(ebsVolume: ec2.Volume) {
  let iopsLimit: number;
  let throughputLimit: number;
  switch (ebsVolume.VolumeType!) {
    case ec2.VolumeType.io1:
      if (!ebsVolume.Iops)
        throw new Error("io1 volumes must have an iops configured");
      iopsLimit = ebsVolume.Iops;
      throughputLimit = Math.max(
        /* limit256 = */ Math.min(iopsLimit / 2000, 500),
        /* limit16 = */ Math.min(iopsLimit / 64000, 1000),
      );
      break;
    case ec2.VolumeType.io2:
      if (!ebsVolume.Iops)
        throw new Error("io2 volumes must have an iops configured");
      iopsLimit = ebsVolume.Iops;
      throughputLimit = Math.min(iopsLimit / 4, 4000);
      break;
    case ec2.VolumeType.gp2:
      iopsLimit = Math.min(ebsVolume.Size! * 3, 16000);
      throughputLimit = Math.max(Math.min(iopsLimit / 4, 250), 128);
      break;
    case ec2.VolumeType.gp3:
      iopsLimit = ebsVolume.Iops ?? 3000;
      throughputLimit = ebsVolume?.Throughput ?? 125;
      break;
    case ec2.VolumeType.st1:
      throughputLimit = Math.min((ebsVolume.Size! * 40) / 1000, 500);
      iopsLimit = throughputLimit; // assumes 1M i/o
      break;
    case ec2.VolumeType.sc1:
      throughputLimit = Math.min((ebsVolume.Size! * 12) / 1000, 192);
      iopsLimit = throughputLimit; // assumes 1M i/o
      break;
    default:
      throw new Error(`Unexpected EBS volume type: ${ebsVolume.VolumeType}`);
  }

  return { iopsLimit, throughputLimit };
}

interface NodesConfig {
  cluster_name: string;
  nodes: [
    number,
    (
      | "Tombstone"
      | {
          Node: Node;
        }
    ),
  ][];
}

interface Node {
  address: string;
  current_generation: [number, number];
  location: string;
  log_server_config: {
    storage_state: string;
  };
  name: string;
  roles: string[];
}

async function getNodesConfig(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
): Promise<NodesConfig> {
  try {
    const output = await restatectl(lambdaClient, restatectlLambdaArn, [
      "metadata",
      "get",
      "--key",
      "nodes_config",
    ]);
    const nodesConfig: NodesConfig = JSON.parse(output);
    return nodesConfig;
  } catch (e) {
    console.log(`Failed to get nodes_config: ${e}`);
    return { cluster_name: "", nodes: [] };
  }
}

interface BifrostConfig {
  logs?: [number, Chain][];
  config?: {
    default_provider?:
      | "in-memory"
      | "local"
      | {
          replicated?: {
            replication_property?: string | number;
          };
        };
  };
}

interface Chain {
  chain?: [number, LogletConfig][];
}

interface LogletConfig {
  kind: "local" | "in-memory" | "replicated";
  params: string;
  index: number;
}

interface ReplicatedLogletConfig {
  sequencer: string;
  nodeset: number[];
}

async function getBifrostConfig(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
): Promise<BifrostConfig> {
  try {
    const output = await restatectl(lambdaClient, restatectlLambdaArn, [
      "metadata",
      "get",
      "--key",
      "bifrost_config",
    ]);
    const bifrostConfig: BifrostConfig = JSON.parse(output);

    bifrostConfig.logs?.sort((a, b) => a[0] - b[0]);

    return bifrostConfig;
  } catch (e) {
    console.log(`Failed to get bifrost_config: ${e}`);
    return { logs: [] };
  }
}

interface PartitionTable {
  num_partitions?: number;
  partitions?: [number, Partition][];
  replication?: {
    limit?: string | number;
  };
}

interface Partition {
  placement?: number[];
}

async function getPartitionTable(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
): Promise<PartitionTable> {
  try {
    const output = await restatectl(lambdaClient, restatectlLambdaArn, [
      "metadata",
      "get",
      "--key",
      "partition_table",
    ]);
    const bifrostConfig: PartitionTable = JSON.parse(output);
    return bifrostConfig;
  } catch (e) {
    console.log(`Failed to get partition_table: ${e}`);
    return { num_partitions: 0, partitions: [], replication: undefined };
  }
}

async function getLicenseKeyOrg(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
): Promise<string> {
  try {
    const output = await restatectl(lambdaClient, restatectlLambdaArn, [
      "metadata",
      "get",
      "--key",
      "license_key",
    ]);
    const licenceKey = JSON.parse(output) as { license_key?: string };
    if (!licenceKey.license_key)
      throw new Error("No licence_key field in result");

    const claims = JSON.parse(
      Buffer.from(licenceKey.license_key.split(".")[1], "base64").toString(),
    ) as {
      org?: string;
    };

    if (!claims.org) throw new Error("No org field in licence key claims");

    return claims.org;
  } catch (e) {
    console.log(`Failed to get license key org: ${e}`);
    return "Unknown";
  }
}

function getNodes(
  nodesConfig: NodesConfig,
  nodeState: RestatectlSqlOutput,
  bifrostConfig: BifrostConfig,
  partitionTable: PartitionTable,
  statelessTasks: ecs.Task[],
  statefulTasks: ecs.Task[],
  volumes: Volume[],
) {
  const nodes = nodesConfig.nodes
    .map((node) => (node[1] !== "Tombstone" ? node[1].Node : undefined))
    .filter((node) => node !== undefined);

  const nodesByName = Object.fromEntries<Node | undefined>(
    nodes.map((node) => [node.name, node]),
  );

  let nodeStatusByID: { [k: string]: string | undefined } = {};
  const nodeStateIDCol = nodeState.headers.get("PLAIN_NODE_ID");
  const nodeStateStatusCol = nodeState.headers.get("STATUS");
  if (nodeStateIDCol !== undefined && nodeStateStatusCol !== undefined) {
    nodeStatusByID = Object.fromEntries<string | undefined>(
      nodeState.rows.map((row) => [
        row[nodeStateIDCol],
        row[nodeStateStatusCol],
      ]),
    );
  }

  const volumesByTaskArn = Object.fromEntries<Volume | undefined>(
    volumes.map((volume) => [volume.taskArn, volume]),
  );

  const leadersByNode = new Map<number, number>();
  const followersByNode = new Map<number, number>();

  partitionTable?.partitions?.forEach(([_partitionId, partition]) => {
    if (!partition.placement?.length) return;

    const leader = partition.placement[0];

    leadersByNode.set(leader, (leadersByNode.get(leader) ?? 0) + 1);

    partition.placement.slice(1).forEach((follower) => {
      followersByNode.set(follower, (followersByNode.get(follower) ?? 0) + 1);
    });
  });

  const nodesetsByNode = new Map<number, number>();

  bifrostConfig.logs?.forEach(([_logId, chain]) => {
    chain.chain?.forEach(([_lsn, logletConfig]) => {
      if (logletConfig.kind !== "replicated") return;
      const params: ReplicatedLogletConfig = JSON.parse(logletConfig.params);
      params.nodeset.forEach((node) => {
        nodesetsByNode.set(node, (nodesetsByNode.get(node) ?? 0) + 1);
      });
    });
  });

  const statefulNodes: StatefulTaskProps[] = [];

  // stateful nodes that show up as tasks
  statefulTasks.forEach((task) => {
    const node = nodesByName[task.taskArn!];
    delete nodesByName[task.taskArn!];

    const nodeID = node?.current_generation
      ? `N${node.current_generation[0]}`
      : undefined;
    const genNodeID = nodeID
      ? `${nodeID}:${node?.current_generation[1]}`
      : undefined;
    const nodeStatus = nodeID ? nodeStatusByID[nodeID] : undefined;

    // we only show stopped tasks as nodes if they are still present in nodes config. otherwise, its just confusing
    if (!node && task.lastStatus == "STOPPED") return;

    statefulNodes.push({
      taskID: task.taskArn!.split("/").pop()!,
      availabilityZone: task.availabilityZone ?? "N/A",
      lastStatus: task.lastStatus ?? "UNKNOWN",
      desiredStatus: task.desiredStatus ?? "UNKNOWN",
      taskDefinition: task.taskDefinitionArn,
      healthStatus: task.healthStatus ?? "UNKNOWN",
      cpu: task.cpu ?? "",
      memory: task.memory ?? "",
      startedAt: task.startedAt?.toISOString() ?? "Not Started",
      nodeID: genNodeID ?? "",
      nodeStatus: nodeStatus ?? "",
      storageState: node?.log_server_config.storage_state ?? "",
      leader: node?.current_generation
        ? (leadersByNode.get(node.current_generation[0]) ?? 0)
        : 0,
      follower: node?.current_generation
        ? (followersByNode.get(node.current_generation[0]) ?? 0)
        : 0,
      nodesetMember: node?.current_generation
        ? (nodesetsByNode.get(node.current_generation[0]) ?? 0)
        : 0,
      storage: volumesByTaskArn[task.taskArn!]?.sizeInGiB
        ? `${volumesByTaskArn[task.taskArn!]?.sizeInGiB} GB`
        : "",
    } satisfies StatefulTaskProps);
  });

  const statelessNodes: StatelessTaskProps[] = [];

  // stateless nodes that show up as tasks
  statelessTasks.forEach((task) => {
    const node = nodesByName[task.taskArn!];
    delete nodesByName[task.taskArn!];

    const nodeID = node?.current_generation
      ? `N${node.current_generation[0]}`
      : undefined;
    const genNodeID = nodeID
      ? `${nodeID}:${node?.current_generation[1]}`
      : undefined;
    const nodeStatus = nodeID ? nodeStatusByID[nodeID] : undefined;

    // we only show stopped tasks as nodes if they are still present in nodes config. otherwise, its just confusing
    if (!node && task.lastStatus == "STOPPED") return;

    statelessNodes.push({
      taskID: task.taskArn!.split("/").pop()!,
      availabilityZone: task.availabilityZone ?? "N/A",
      lastStatus: task.lastStatus ?? "UNKNOWN",
      desiredStatus: task.desiredStatus ?? "UNKNOWN",
      taskDefinition: task.taskDefinitionArn,
      healthStatus: task.healthStatus ?? "UNKNOWN",
      cpu: task.cpu!,
      memory: task.memory!,
      startedAt: task.startedAt?.toISOString() ?? "Not Started",
      nodeID: genNodeID ?? "",
      nodeStatus: nodeStatus ?? "",
    } satisfies StatelessTaskProps);
  });

  // nodes that do not have associated tasks - presumably deleted
  Object.entries(nodesByName).forEach(([name, node]) => {
    if (!node) {
      return;
    }

    if (!name.startsWith("arn:aws:ecs:")) {
      // some other node that isn't an ecs task
      return;
    }

    const nodeID = `N${node.current_generation[0]}`;
    const genNodeID = `${nodeID}:${node.current_generation[1]}`;
    const nodeStatus = nodeStatusByID[nodeID];

    if (node.roles.includes("log-server")) {
      statefulNodes.push({
        taskID: name.split("/").pop()!,
        availabilityZone: "N/A",
        lastStatus: "DELETED",
        desiredStatus: "DELETED",
        taskDefinition: undefined,
        healthStatus: "UNKNOWN",
        cpu: "",
        memory: "",
        startedAt: "",
        nodeID: genNodeID,
        nodeStatus: nodeStatus ?? "",
        storageState: node.log_server_config.storage_state,
        leader: leadersByNode.get(node.current_generation[0]) ?? 0,
        follower: followersByNode.get(node.current_generation[0]) ?? 0,
        nodesetMember: nodesetsByNode.get(node.current_generation[0]) ?? 0,
        storage: "",
      } satisfies StatefulTaskProps);
    } else {
      statelessNodes.push({
        taskID: name.split("/").pop()!,
        availabilityZone: "N/A",
        lastStatus: "DELETED",
        desiredStatus: "DELETED",
        taskDefinition: undefined,
        healthStatus: "UNKNOWN",
        cpu: "",
        memory: "",
        startedAt: "",
        nodeID: genNodeID,
        nodeStatus: nodeStatus ?? "",
      } satisfies StatelessTaskProps);
    }
  });

  return { statefulNodes, statelessNodes };
}

async function restatectl(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
  args: string[],
): Promise<string> {
  const result = await lambdaClient.send(
    new lambda.InvokeCommand({
      FunctionName: restatectlLambdaArn,
      Payload: JSON.stringify({
        args,
      }),
    }),
  );

  if (result.FunctionError)
    throw new Error(
      `Failed to invoke restatectl lambda: ${result.FunctionError}`,
    );

  if (!result.Payload)
    throw new Error("restatectl lambda did not return a payload");

  const payload: { status: number; stdout: string; stderr: string } =
    JSON.parse(result.Payload.transformToString());

  if (payload.status !== 0)
    throw new Error(
      `restatectl returned exit status ${payload.status}. Stdout: '${payload.stdout}. Stderr: '${payload.stderr}'`,
    );

  return payload.stdout;
}

function getLogs(bifrostConfig: BifrostConfig): {
  count: number;
  replication?: { node?: number; zone?: number; region?: number };
  info: LogInfo[];
} {
  const replication =
    bifrostConfig.config?.default_provider &&
    typeof bifrostConfig.config.default_provider == "object" &&
    "replicated" in bifrostConfig.config.default_provider
      ? parseReplicationFactor(
          bifrostConfig.config.default_provider.replicated
            ?.replication_property,
        )
      : undefined;

  const info: LogInfo[] = [];

  bifrostConfig.logs?.forEach(([logID, log]) => {
    if (!Array.isArray(log.chain)) return;
    const tailSegment = log.chain[log.chain.length - 1];
    if (!tailSegment || !Array.isArray(tailSegment) || !tailSegment[1]) return;
    if (tailSegment[1].kind !== "replicated") return;
    const params: ReplicatedLogletConfig = JSON.parse(tailSegment[1].params);

    info.push({
      logID: `${logID}`,
      fromLSN: `${tailSegment[0]}`,
      logletID: `${logID}_${tailSegment[1].index}`,
      sequencer: params.sequencer,
      nodeSet: `[${params.nodeset.map((node) => `N${node}`).join(", ")}]`,
    });
  });

  return {
    count: bifrostConfig.logs?.length ?? 0,
    replication,
    info,
  };
}

const REPLICATION_FACTOR_EXTRACTOR =
  /(?<scope>node|zone|region)\s*:\s*(?<factor>\d+)/gim;

function parseReplicationFactor(
  factor?: string | number,
): { node?: number; zone?: number; region?: number } | undefined {
  if (factor == undefined) return undefined;

  if (typeof factor == "number") {
    if (factor == 0) return undefined;
    return { node: factor };
  }

  const maybeInt = parseInt(factor);
  if (!Number.isNaN(maybeInt)) {
    if (maybeInt == 0) return undefined;
    return { node: maybeInt };
  }

  const factors: { region?: number; zone?: number; node?: number } = {};

  for (const match of factor.matchAll(REPLICATION_FACTOR_EXTRACTOR)) {
    const scope = match.groups?.["scope"];
    const factor = match.groups?.["factor"];
    if (!scope || !factor) continue;
    const factorInt = parseInt(factor);
    if (Number.isNaN(factorInt) || factorInt == 0) continue;

    if (scope == "node" || scope == "zone" || scope == "region") {
      factors[scope] = factorInt;
    }
  }

  if (!(factors.region || factors.zone || factors.node)) return undefined;

  return factors;
}

interface RestatectlSqlOutput {
  headers: Map<string, number>;
  rows: string[][];
}

async function restatectlSql(
  lambdaClient: lambda.LambdaClient,
  restatectlLambdaArn: string,
  query: string,
): Promise<RestatectlSqlOutput> {
  try {
    const table = await restatectl(lambdaClient, restatectlLambdaArn, [
      "sql",
      query,
    ]);

    const tableLines = table.split("\n");
    const headers = tableLines[0];
    const labels: { label: string; index: number }[] = [];
    for (const word of headers.matchAll(/[^\s]+/g)) {
      labels.push({ label: word[0], index: word.index });
    }

    return {
      headers: new Map(labels.map((l, i) => [l.label, i])),
      rows: tableLines.slice(1, tableLines.length - 2).map((line) => {
        return labels.map((label, i) => {
          const startIndex = label.index;
          const endIndex = labels[i + 1] ? labels[i + 1].index : line.length;

          return line.slice(startIndex, endIndex).trim();
        });
      }),
    };
  } catch (e) {
    console.log(`Failed to get partition list: ${e}`);
    return {
      headers: new Map(),
      rows: [],
    };
  }
}

function getPartitions(
  partitionTable: PartitionTable,
  partitionState: RestatectlSqlOutput,
): {
  count: number;
  replication?: { node?: number; zone?: number; region?: number };
  info: PartitionInfo[];
} {
  const getLabel = (label: string, row: string[]): string => {
    const i = partitionState.headers.get(label);
    if (i === undefined) return "";
    return row[i] ?? "";
  };

  const info = partitionState.rows.map((row) => {
    const appliedLSN = getLabel("APPLIED_LOG_LSN", row);
    const targetTailLSN = getLabel("TARGET_TAIL_LSN", row);

    const appliedLSNNumber = Number(targetTailLSN);
    const targetTailLSNNumber = Number(appliedLSN);

    let lsnLag = "";
    if (!Number.isNaN(appliedLSNNumber) && !Number.isNaN(targetTailLSNNumber)) {
      // (tail - 1) - applied_lsn = tail - (applied_lsn + 1)
      lsnLag = Math.max(targetTailLSNNumber - appliedLSNNumber, 0).toString();
    }
    return {
      partitionID: getLabel("PARTITION_ID", row),
      nodeID: getLabel("GEN_NODE_ID", row),
      mode: getLabel("EFFECTIVE_MODE", row),
      status: getLabel("REPLAY_STATUS", row),
      leader: getLabel("LEADER", row),
      appliedLSN,
      persistedLSN: getLabel("PERSISTED_LOG_LSN", row),
      archivedLSN: getLabel("ARCHIVED_LOG_LSN", row),
      targetTailLSN,
      lsnLag,
      lastUpdate: getLabel("UPDATED_AT", row),
    } satisfies PartitionInfo;
  });

  const replication = parseReplicationFactor(partitionTable.replication?.limit);

  return {
    count: partitionTable.num_partitions ?? 0,
    replication,
    info,
  };
}

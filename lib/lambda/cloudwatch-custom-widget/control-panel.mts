import * as styles from "./styles.mjs";
import type { Context } from "aws-lambda";
import { RESTATE_LOGO } from "./static.mjs";
import { ControlPanelWidgetEvent, WidgetContext } from "./index.mjs";
import { getControlPanel } from "./readers.mjs";

export interface ControlPanelProps {
  summary: {
    clusterName: string;
    licensedTo: string;
    usage: {
      cpuPercent?: number;
      memoryPercent?: number;
      storagePercent?: number;
    };
    status: string;
    restateVersion: string;
    stackVersion: string;
    metricsDashboardName?: string;
    tasks: {
      stateless: {
        desired: number;
        pending: number;
        running: number;
      };
      stateful: {
        desired: number;
        pending: number;
        running: number;
      };
      controller: {
        desired: number;
        pending: number;
        running: number;
      };
    };
  };
  connectivityAndSecurity: {
    region: string;
    connectivity: {
      loadBalancerArns: string[];
      addresses: {
        ingress?: string;
        admin?: string;
        webUI?: string;
      };
    };
    networking: {
      availabilityZones: string[];
      vpc: string;
      subnets: string[];
    };
    security: {
      securityGroups: string[];
      certificate?: {
        id: string;
        expiry?: string;
      };
    };
    identity: {
      restate: {
        taskRole: string;
        taskExecutionRole: string;
      };
    };
  };
  nodes: {
    clusterName: string;
    stateful: {
      logGroup?: string;
      tasks: StatefulTaskProps[];
    };
    stateless: {
      serviceName: string;
      logGroup?: string;
      tasks: StatelessTaskProps[];
    };
    controller: {
      serviceName: string;
      logGroup?: string;
      tasks: TaskProps[];
    };
  };
  storage: {
    s3: {
      bucket: string;
      totalSize?: string;
      objectCount?: number;
    };
    volumes: Volume[];
  };
  replication: {
    partitions: {
      count: number;
      replication?: { node?: number; zone?: number; region?: number };
      info: PartitionInfo[];
    };
    logs: {
      count: number;
      replication?: { node?: number; zone?: number; region?: number };
      info: LogInfo[];
    };
  };
}

export interface LogInfo {
  logID: string;
  fromLSN: string;
  logletID: string;
  sequencer: string;
  nodeSet: string;
}

export interface PartitionInfo {
  partitionID: string;
  nodeID: string;
  mode: string;
  status: string;
  leader: string;
  appliedLSN: string;
  persistedLSN: string;
  archivedLSN: string;
  targetTailLSN: string;
  lsnLag: string;
  lastUpdate: string;
}

export type Volume = {
  taskArn: string;
  volumeID?: string;
  availabilityZone: string;
  type: string;
  sizeInGiB: number;
  iops: number;
  throughput: number;
  state: "creating" | "available" | "in-use" | "deleting" | "deleted" | "error";
  statusCheck:
    | "ok"
    | "warning"
    | "impaired"
    | "insufficient-data"
    | "not-available";
};

export interface TaskProps {
  taskID: string;
  availabilityZone: string;
  lastStatus:
    | "PROVISIONING"
    | "PENDING"
    | "ACTIVATING"
    | "RUNNING"
    | "DEACTIVATING"
    | "STOPPING"
    | "DEPROVISIONING"
    | "STOPPED"
    | "DELETED"
    | string;
  desiredStatus: "PENDING" | "RUNNING" | "STOPPED" | "DELETED" | string;
  taskDefinition?: string;
  healthStatus: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  cpu: string;
  memory: string;
  startedAt: string;
}

export type RestateTaskProps = TaskProps & {
  nodeID: string;
  nodeStatus: "alive" | "dead" | "suspect" | string;
};

export type StatefulTaskProps = RestateTaskProps & {
  storageState:
    | "provisioning"
    | "disabled"
    | "read-only"
    | "gone"
    | "read-write"
    | "data-loss"
    | string;
  leader: number;
  follower: number;
  nodesetMember: number;
  storage: string;
};

export type StatelessTaskProps = RestateTaskProps;

export async function controlPanelRefresh(
  context: Context,
  widgetContext: WidgetContext,
) {
  if (typeof widgetContext.params !== "object" || widgetContext.params === null)
    throw new Error("Invalid widgetContext params");
  if (!("command" in widgetContext.params))
    throw new Error("Missing 'command' in widgetContext params");
  if (widgetContext.params.command !== "controlPanel")
    throw new Error(
      `Unexpected command ${widgetContext.params.command} in widgetContext params`,
    );
  if (!("input" in widgetContext.params))
    throw new Error("Missing 'input' in widgetContext params");
  if (
    typeof widgetContext.params.input !== "object" ||
    widgetContext.params.input === null
  )
    throw new Error("Invalid widgetContext params.inputs");

  const params = widgetContext.params as ControlPanelWidgetEvent;

  return await controlPanel(context, widgetContext, {
    ...params,
  });
}

export async function controlPanel(
  context: Context,
  widgetContext: WidgetContext,
  event: ControlPanelWidgetEvent,
) {
  const props = await getControlPanel(event.input);
  const summary = styles.contentWrapper(
    true,
    `<div class="awsui_horizontal awsui_horizontal-s"><div>Summary</div><img alt="restate logo" src="${RESTATE_LOGO}" width="85px"></img><div>`,
    styles.columns(
      styles.vertical(
        "s",
        styles.keyValue("Cluster name", props.summary.clusterName),
        styles.keyValue("Licensed to", props.summary.licensedTo),
      ),
      styles.vertical(
        "s",
        styles.keyValue("Status", props.summary.status),
        styles.usageIndicators(
          ...definedList(
            props.summary.usage.cpuPercent !== undefined
              ? {
                  title: "CPU",
                  usagePercent: props.summary.usage.cpuPercent,
                }
              : undefined,
            props.summary.usage.memoryPercent !== undefined
              ? {
                  title: "Memory",
                  usagePercent: props.summary.usage.memoryPercent,
                }
              : undefined,
            props.summary.usage.storagePercent !== undefined
              ? {
                  title: "Storage",
                  usagePercent: props.summary.usage.storagePercent,
                }
              : undefined,
          ),
        ),
      ),
      styles.vertical(
        "s",
        styles.taskStats("Stateless nodes", props.summary.tasks.stateless),
        styles.taskStats("Stateful nodes", props.summary.tasks.stateful),
        styles.taskStats("Controller", props.summary.tasks.controller),
      ),
      styles.vertical(
        "s",
        // todo link to github releases for these two?
        styles.keyValue("Restate Version", props.summary.restateVersion),
        styles.keyValue("Stack Version", props.summary.stackVersion),
      ),
    ),
    true,
    [
      styles.buttonLink(
        `/cloudwatch/home?region=${props.connectivityAndSecurity.region}#dashboards/dashboard/${props.summary.metricsDashboardName}`,
        "CloudWatch Metrics",
      ),
    ],
  );

  const addresses = styles.vertical(
    "m",
    styles.heading("h3", "Connectivity"),
    styles.keyValue(
      "Load balancers",
      styles.list(
        ...props.connectivityAndSecurity.connectivity.loadBalancerArns.map(
          (loadBalancerArn) => {
            const parts = loadBalancerArn.split("/");
            return styles.link(
              `/ec2/home?region=${props.connectivityAndSecurity.region}#LoadBalancer:loadBalancerArn=${loadBalancerArn}`,
              parts[parts.length - 2] ?? loadBalancerArn,
            );
          },
        ),
      ),
    ),
    ...(props.connectivityAndSecurity.connectivity.addresses.ingress
      ? [
          styles.keyValue(
            "Ingress endpoint",
            props.connectivityAndSecurity.connectivity.addresses.ingress,
          ),
        ]
      : []),
    ...(props.connectivityAndSecurity.connectivity.addresses.admin
      ? [
          styles.keyValue(
            "Admin endpoint",
            props.connectivityAndSecurity.connectivity.addresses.admin,
          ),
        ]
      : []),
    ...(props.connectivityAndSecurity.connectivity.addresses.webUI
      ? [
          styles.keyValue(
            "Restate UI",
            styles.link(
              props.connectivityAndSecurity.connectivity.addresses.webUI,
              props.connectivityAndSecurity.connectivity.addresses.webUI,
            ),
          ),
        ]
      : []),
  );

  const networking = styles.vertical(
    "m",
    styles.heading("h3", `Networking`),
    styles.keyValue(
      "Availability Zones",
      styles.list(
        ...props.connectivityAndSecurity.networking.availabilityZones,
      ),
    ),
    styles.keyValue(
      "VPC",
      styles.link(
        `/vpc/home?region=${props.connectivityAndSecurity.region}#vpcs:VpcId=${props.connectivityAndSecurity.networking.vpc}`,
        props.connectivityAndSecurity.networking.vpc,
      ),
    ),
    styles.keyValue(
      "Subnets",
      styles.list(
        ...props.connectivityAndSecurity.networking.subnets.map((subnet) =>
          styles.link(
            `/vpc/home?region=${props.connectivityAndSecurity.region}#subnets:SubnetId=${subnet}`,
            subnet,
          ),
        ),
      ),
    ),
  );

  const certificate = props.connectivityAndSecurity.security.certificate
    ? [
        styles.keyValue(
          "Certificate",
          styles.link(
            `/acm/home?region=${props.connectivityAndSecurity.region}#/certificates/${props.connectivityAndSecurity.security.certificate.id}`,
            props.connectivityAndSecurity.security.certificate.id,
          ),
        ),
        ...(props.connectivityAndSecurity.security.certificate.expiry
          ? [
              styles.keyValue(
                "Certificate expiry",
                props.connectivityAndSecurity.security.certificate.expiry,
              ),
            ]
          : []),
      ]
    : [];

  const security = styles.vertical(
    "m",
    styles.heading("h3", `Security`),
    styles.keyValue(
      "VPC Security groups",
      styles.list(
        ...props.connectivityAndSecurity.security.securityGroups.map((id) =>
          styles.link(
            `/ec2/v2/home?region=${props.connectivityAndSecurity.region}#SecurityGroups:search=${id}`,
            id,
          ),
        ),
      ),
    ),
    ...certificate,
  );

  const identity = styles.vertical(
    "m",
    styles.heading("h3", `Identity`),
    styles.keyValue(
      "Restate task role",
      styles.link(
        `/iam/home?region=${props.connectivityAndSecurity.region}#roles/${props.connectivityAndSecurity.identity.restate.taskRole}`,
        props.connectivityAndSecurity.identity.restate.taskRole,
      ),
    ),
    styles.keyValue(
      "Restate task execution role",
      styles.link(
        `/iam/home?region=${props.connectivityAndSecurity.region}#roles/${props.connectivityAndSecurity.identity.restate.taskExecutionRole}`,
        props.connectivityAndSecurity.identity.restate.taskExecutionRole,
      ),
    ),
  );

  const connectivity = styles.vertical(
    "l",
    styles.contentWrapper(
      true,
      "Connectivity & security",
      styles.columns(addresses, networking, security, identity),
    ),
  );

  const numericCompare = (a: string, b: string) => Number(a) - Number(b);

  const statefulNodesHeaders: styles.TableHeader[] = [
    { name: "Node ID" },
    { name: "Task" },
    { name: "Availability zone" },
    { name: "Node status" },
    { name: "Storage state" },
    { name: "Leader", compare: numericCompare },
    { name: "Follower", compare: numericCompare },
    { name: "Nodeset member", compare: numericCompare },
    { name: "ECS Last status" },
    { name: "ECS Desired status" },
    { name: "ECS Health status" },
    { name: "Task definition" },
    { name: "CPU" },
    { name: "Memory" },
    { name: "Storage" },
    { name: "Started at" },
  ];

  const statefulNodesRows = props.nodes.stateful.tasks.map((node) => {
    const taskDefinitionName = node.taskDefinition?.split("/").pop();
    return [
      node.nodeID,
      styles.link(
        `/ecs/v2/clusters/${props.nodes.clusterName}/tasks/${node.taskID}?region=${props.connectivityAndSecurity.region}`,
        node.taskID,
      ),
      node.availabilityZone,
      styles.nodeStatus(node.nodeStatus),
      styles.storageState(node.storageState),
      `${node.leader}`,
      `${node.follower}`,
      `${node.nodesetMember}`,
      styles.ecsLastStatus(node.lastStatus),
      styles.ecsDesiredStatus(node.desiredStatus),
      styles.healthStatus(node.healthStatus),
      taskDefinitionName
        ? styles.link(
            `/ecs/v2/task-definitions/${taskDefinitionName.replace(":", "/")}?region=${props.connectivityAndSecurity.region}`,
            taskDefinitionName,
          )
        : "",
      node.cpu,
      node.memory,
      node.storage,
      node.startedAt,
    ];
  });

  const statefulNodes = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "statefulNodes",
    "Stateful nodes",
    statefulNodesHeaders,
    statefulNodesRows,
    "No nodes",
    [
      ...(props.nodes.stateless.logGroup
        ? [
            styles.buttonLink(
              `/cloudwatch/home?region=${props.connectivityAndSecurity.region}#logsV2:log-groups/log-group/${props.nodes.stateful.logGroup}/log-events`,
              "CloudWatch Logs",
            ),
          ]
        : []),
    ],
  );

  const statelessNodesHeaders: styles.TableHeader[] = [
    { name: "Node ID" },
    { name: "Task" },
    { name: "Availability zone" },
    { name: "Node status" },
    { name: "ECS Last status" },
    { name: "ECS Desired status" },
    { name: "ECS Health status" },
    { name: "Task definition" },
    { name: "CPU" },
    { name: "Memory" },
    { name: "Started at" },
  ];

  const statelessNodesRows = props.nodes.stateless.tasks.map((node) => {
    const taskDefinitionName = node.taskDefinition?.split("/").pop();
    return [
      node.nodeID,
      styles.link(
        `/ecs/v2/clusters/${props.nodes.clusterName}/tasks/${node.taskID}?region=${props.connectivityAndSecurity.region}`,
        node.taskID,
      ),
      node.availabilityZone,
      styles.nodeStatus(node.nodeStatus),
      styles.ecsLastStatus(node.lastStatus),
      styles.ecsDesiredStatus(node.desiredStatus),
      styles.healthStatus(node.healthStatus),
      taskDefinitionName
        ? styles.link(
            `/ecs/v2/task-definitions/${taskDefinitionName.replace(":", "/")}?region=${props.connectivityAndSecurity.region}`,
            taskDefinitionName,
          )
        : "",
      node.cpu,
      node.memory,
      node.startedAt,
    ];
  });

  const statelessNodes = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "statelessNodes",
    "Stateless nodes",
    statelessNodesHeaders,
    statelessNodesRows,
    "No nodes",
    [
      styles.buttonLink(
        `/ecs/v2/clusters/${props.nodes.clusterName}/services/${props.nodes.stateless.serviceName}/health?region=${props.connectivityAndSecurity.region}`,
        "Service",
      ),
      ...(props.nodes.stateless.logGroup
        ? [
            styles.buttonLink(
              `/cloudwatch/home?region=${props.connectivityAndSecurity.region}#logsV2:log-groups/log-group/${props.nodes.stateless.logGroup}/log-events`,
              "CloudWatch Logs",
            ),
          ]
        : []),
    ],
  );

  const controllerHeaders = [
    { name: "Task" },
    { name: "Availability zone" },
    { name: "Last status" },
    { name: "Desired status" },
    { name: "Health status" },
    { name: "Task definition" },
    { name: "CPU" },
    { name: "Memory" },
    { name: "Started at" },
  ];

  const controllerRows = props.nodes.controller.tasks.map((node) => {
    const taskDefinitionName = node.taskDefinition?.split("/").pop();
    return [
      styles.link(
        `/ecs/v2/clusters/${props.nodes.clusterName}/tasks/${node.taskID}?region=${props.connectivityAndSecurity.region}`,
        node.taskID,
      ),
      node.availabilityZone,
      styles.ecsLastStatus(node.lastStatus),
      styles.ecsDesiredStatus(node.desiredStatus),
      styles.healthStatus(node.healthStatus),
      taskDefinitionName
        ? styles.link(
            `/ecs/v2/task-definitions/${taskDefinitionName.replace(":", "/")}?region=${props.connectivityAndSecurity.region}`,
            taskDefinitionName,
          )
        : "",
      node.cpu,
      node.memory,
      node.startedAt,
    ];
  });

  const controllerTasks = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "controllerTasks",
    "Controller tasks",
    controllerHeaders,
    controllerRows,
    "No tasks",
    [
      styles.buttonLink(
        `/ecs/v2/clusters/${props.nodes.clusterName}/services/${props.nodes.controller.serviceName}/health?region=${props.connectivityAndSecurity.region}`,
        "Service",
      ),
      ...(props.nodes.controller.logGroup
        ? [
            styles.buttonLink(
              `/cloudwatch/home?region=${props.connectivityAndSecurity.region}#logsV2:log-groups/log-group/${props.nodes.controller.logGroup}/log-events`,
              "CloudWatch Logs",
            ),
          ]
        : []),
    ],
  );

  const compute = styles.vertical(
    "l",
    statefulNodes,
    statelessNodes,
    controllerTasks,
  );

  const s3Bucket = styles.contentWrapper(
    true,
    "S3",
    styles.columns(
      styles.keyValue(
        "Bucket",
        styles.link(
          `/s3/buckets/${props.storage.s3.bucket}?region=${props.connectivityAndSecurity.region}`,
          props.storage.s3.bucket,
        ),
      ),
      ...(props.storage.s3.totalSize
        ? [styles.keyValue("Total size", props.storage.s3.totalSize)]
        : []),
      ...(props.storage.s3.objectCount !== undefined
        ? [
            styles.keyValue(
              "Number of objects",
              `${props.storage.s3.objectCount}`,
            ),
          ]
        : []),
    ),
  );

  const volumeHeaders: styles.TableHeader[] = [
    { name: "Volume" },
    { name: "Type" },
    { name: "Size" },
    { name: "IOPS", compare: numericCompare },
    { name: "Throughput", compare: numericCompare },
    { name: "Availability zone" },
    { name: "Volume state" },
    { name: "Status check" },
  ];

  const volumeRows: string[][] = props.storage.volumes.map((volume) => {
    const taskID = volume.taskArn.split("/").pop()!;
    return [
      volume.volumeID
        ? styles.link(
            `/ec2/home?region=${props.connectivityAndSecurity.region}#VolumeDetails:volumeId=${volume.volumeID}`,
            volume.volumeID,
          )
        : styles.link(
            `/ecs/v2/clusters/${props.nodes.clusterName}/tasks/${taskID}/volumes?region=${props.connectivityAndSecurity.region}`,
            `${taskID} (ephemeral)`,
          ),
      volume.type,
      `${volume.sizeInGiB} GB`,
      `${volume.iops}`,
      `${volume.throughput}`,
      volume.availabilityZone,
      styles.volumeState(volume.state),
      styles.volumeStatus(volume.statusCheck),
    ];
  });

  const volumes = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "volumes",
    "Volumes",
    volumeHeaders,
    volumeRows,
    "No volumes",
  );
  const storage = styles.vertical("l", s3Bucket, volumes);

  const replicationFactor = (replication?: {
    node?: number;
    zone?: number;
    region?: number;
  }) => {
    if (!replication) return undefined;

    if (replication.region) {
      if (replication.region == 1) {
        return "1 region";
      } else {
        return `${replication.region} regions`;
      }
    } else if (replication.zone) {
      if (replication.zone == 1) {
        return "1 zone";
      } else {
        return `${replication.zone} zones`;
      }
    } else if (replication.node) {
      if (replication.node == 1) {
        return "1 node";
      } else {
        return `${replication.node} nodes`;
      }
    } else {
      return undefined;
    }
  };

  const partitionHeaders: styles.TableHeader[] = [
    { name: "Partition ID", compare: numericCompare },
    { name: "Node ID" },
    { name: "Mode" },
    { name: "Status" },
    { name: "Leader" },
    { name: "Applied LSN", compare: numericCompare },
    { name: "Persisted LSN", compare: numericCompare },
    {
      name: "Archived LSN",
      compare: (a: string, b: string) => {
        if (a == "-" && b == "-") return 0;
        if (a == "-" && b != "-") return -1;
        if (a != "-" && b == "-") return 1;
        return numericCompare(a, b);
      },
    },
    { name: "LSN Lag", compare: numericCompare },
    { name: "Last update" },
  ];

  const partitionRows = props.replication.partitions.info.map((partition) => [
    partition.partitionID,
    partition.nodeID,
    styles.partitionMode(partition.mode),
    styles.partitionStatus(partition.status, partition.targetTailLSN),
    partition.leader,
    partition.appliedLSN,
    partition.persistedLSN,
    partition.archivedLSN,
    partition.lsnLag,
    partition.lastUpdate,
  ]);

  const partitionReplication = replicationFactor(
    props.replication.partitions.replication,
  );
  const partitions = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "partitions",
    partitionReplication
      ? `<span>Partitions ${styles.counter(`(${props.replication.partitions.count})`)}</span><span style="color: #656871; font-weight: normal; line-height: 16px; margin: 6px; font-size: 12px">Replicated over ${partitionReplication}</span>`
      : `<span>Partitions ${styles.counter(`(${props.replication.partitions.count})`)}</span>`,
    partitionHeaders,
    partitionRows,
    "No partitions",
  );

  const logHeaders: styles.TableHeader[] = [
    { name: "Log ID", compare: numericCompare },
    { name: "From LSN", compare: numericCompare },
    { name: "Loglet ID" },
    { name: "Sequencer" },
    { name: "Nodeset" },
  ];

  const logRows = props.replication.logs.info.map((log) => [
    log.logID,
    log.fromLSN,
    log.logletID,
    log.sequencer,
    log.nodeSet,
  ]);

  const zoneReplication = replicationFactor(props.replication.logs.replication);
  const logs = styles.paginatedTable(
    context,
    widgetContext,
    event,
    "logs",
    zoneReplication
      ? `<span>Logs ${styles.counter(`(${props.replication.logs.count})`)}</span><span style="color: #656871; font-weight: normal; line-height: 16px; margin: 6px; font-size: 12px">Replicated over ${zoneReplication}</span>`
      : `<span>Logs ${styles.counter(`(${props.replication.logs.count})`)}</span>`,
    logHeaders,
    logRows,
    "No logs",
  );

  const replication = styles.vertical("l", partitions, logs);

  const tabs = styles.tabs(
    "mainTabs",
    widgetContext.forms.all,
    {
      header: "Connectivity & security",
      inner: connectivity,
    },
    {
      header: "Compute",
      inner: compute,
    },
    {
      header: "Storage",
      inner: storage,
    },
    {
      header: "Replication",
      inner: replication,
    },
  );

  const body = styles.vertical("m", summary, tabs);

  return `
${styles.css(4, Math.max(statefulNodesRows.length, statelessNodesRows.length, controllerRows.length, volumeRows.length, logRows.length, partitionRows.length), Math.max(statefulNodesHeaders.length, statelessNodesHeaders.length, controllerHeaders.length, volumeHeaders.length, logHeaders.length, partitionHeaders.length))}
${body}
`;
}

function definedList<T>(...items: (T | undefined)[]): T[] {
  return items.filter((item) => item !== undefined);
}

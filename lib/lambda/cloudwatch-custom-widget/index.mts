import type { Context } from "aws-lambda";
import * as lambda from "@aws-sdk/client-lambda";
import * as ec2 from "@aws-sdk/client-ec2";
import * as cloudwatch from "@aws-sdk/client-cloudwatch";

import { controlPanel, type ControlPanelProps } from "./control-panel.mjs";

const lambdaClient = new lambda.LambdaClient({});
const ec2Client = new ec2.EC2Client({});
const cloudwatchClient = new cloudwatch.CloudWatchClient({});

if (!process.env.RESTATECTL_LAMBDA_ARN)
  throw new Error("Missing RESTATECTL_LAMBDA_ARN");
const RESTATECTL_LAMBDA_ARN = process.env.RESTATECTL_LAMBDA_ARN;

type CustomDataSourceEvent = {
  EventType: "GetMetricData";
  GetMetricDataRequest: {
    StartTime: number;
    EndTime: number;
    Period: number;
    Arguments: ["volumeIOPs", string, "Read" | "Write"];
  };
};

type CustomDataSourceResponse =
  | {
      Messages?: cloudwatch.MessageData[];
      MetricDataResults?: {
        StatusCode?: "Complete" | "InternalError" | "PartialData" | "Forbidden";
        Label?: string;
        Timestamps?: number[];
        Values?: number[];
        Messages?: cloudwatch.MessageData[];
      }[];
    }
  | {
      Error: {
        Code?: string;
        Value?: string;
      };
    };

type CustomDataSourceDescribeEvent = {
  EventType: "DescribeGetMetricData";
};

type CustomDataSourceDescribeResponse = {
  Description: string;
  ArgumentDefaults?: [
    {
      Value: string;
    },
  ];
};

type WidgetEvent = {
  widgetContext: WidgetContext;
} & (
  | {
      describe: true;
    }
  | { command: "nodesList" }
  | { command: "echo"; echo: string }
  | ControlPanelWidgetEvent
);

export type ControlPanelWidgetEvent = {
  command: "controlPanel";
  props?: ControlPanelProps;
  checkedRadios?: { [name: string]: string | undefined };
};

interface VolumeGraphWidget {
  metrics: Metric[];
}

type Metric = [...string[], Record<string, unknown>];

interface WidgetContext {
  dashboardName: string;
  widgetId: string;
  accountId: string;
  locale: string;
  timezone: {
    label: string;
    offsetISO: string;
    offsetInMinutes: number;
  };
  period: number;
  isAutoPeriod: boolean;
  timeRange: {
    mode: string;
    start: number;
    end: number;
    relativeStart: number;
    zoom: {
      start: number;
      end: number;
    };
  };
  theme: string;
  title: string;
  width: number;
  height: number;
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

const DOCS = `
## Display Restate cluster information
Retrieves Restate cluster information from restatectl and displays it
`;

export const handler = async (
  event: CustomDataSourceEvent | CustomDataSourceDescribeEvent | WidgetEvent,
  context: Context,
): Promise<
  CustomDataSourceResponse | CustomDataSourceDescribeResponse | string
> => {
  console.log(event);
  if ("EventType" in event) {
    const eventType = event.EventType;
    if (eventType == "GetMetricData") {
      return await customDataSourceHandler(event);
    } else if (eventType == "DescribeGetMetricData") {
      return await customDataSourceDescribeHandler(event);
    } else {
      throw new Error(`Unexpected event type ${eventType}`);
    }
  } else if ("widgetContext" in event) {
    return await widgetHandler(event, context);
  } else {
    throw new Error("Unexpected event payload");
  }
};

export const customDataSourceDescribeHandler = async (
  _event: CustomDataSourceDescribeEvent,
): Promise<CustomDataSourceDescribeResponse> => {
  return {
    Description: "Obtain Restate cluster metric data",
  };
};

export const widgetHandler = async (
  event: WidgetEvent,
  context: Context,
): Promise<string> => {
  if ("describe" in event && event.describe) {
    return DOCS;
  }

  if (!("command" in event)) throw new Error("Missing widget command");

  const command = event.command;
  switch (command) {
    case "nodesList":
      return nodesList();
    case "echo":
      return event.echo || '<pre>No "echo" parameter specified</pre>';
    case "controlPanel":
      return controlPanel(context, event);
    default:
      throw new Error(`Unexpected widget command: ${command}`);
  }
};

async function nodesList() {
  const output = await restatectl(["metadata", "get", "--key", "nodes_config"]);
  const nodesConfig: NodesConfig = JSON.parse(output);

  const nodes = nodesConfig.nodes
    .map(([_, node]) => (node !== "Tombstone" ? node.Node : undefined))
    .filter((node) => node !== undefined);

  nodes.sort((left, right) => {
    return left.current_generation[0] - right.current_generation[0];
  });

  const rows = nodes
    .map((node) => {
      const [taskPrefix, clusterName, taskID] = node.name.split("/");

      const taskRegion = taskPrefix.split(":")[3];

      return `<tr>
                <td>N${node.current_generation[0]}:${node.current_generation[1]}</td>
                <td><a href="/ecs/v2/clusters/${clusterName}/tasks/${taskID}?region=${taskRegion}" target=_blank>${node.name}</a></td>
                <td>${node.address}</td>
                <td>${node.location}</td>
                <td>${node.roles.join(" | ")}</td>
                <td>${node.roles.includes("log-server") ? node.log_server_config.storage_state : "N/A"}</td>
              </tr>`;
    })
    .join("");

  return `<table>
          <tr>
            <th>Node</th><th>Name</th><th>Address</th><th>Location</th><th>Roles</th><th>Storage State</th>
          </tr>
          ${rows}
          </table>`;
}

export const customDataSourceHandler = async (
  event: CustomDataSourceEvent,
): Promise<CustomDataSourceResponse> => {
  if (event.GetMetricDataRequest.Arguments[0] !== "volumeIOPs")
    return {
      Error: {
        Code: "Validation",
        Value: "Unexpected GetMetricDataRequest.Arguments[0]",
      },
    };

  const clusterName = event.GetMetricDataRequest.Arguments[1];
  const typ = event.GetMetricDataRequest.Arguments[2];

  const paginator = ec2.paginateDescribeVolumes(
    {
      client: ec2Client,
      pageSize: 25,
    },
    {
      Filters: [
        {
          Name: "tag:aws:ecs:clusterName",
          Values: [clusterName],
        },
      ],
    },
  );

  const volumes: {
    volumeId: string;
    taskId: string;
  }[] = [];

  try {
    for await (const page of paginator) {
      if (!page.Volumes?.length) continue;

      for (const volume of page.Volumes ?? []) {
        const taskARN = volume.Tags?.find(
          (tag) => tag.Key == "AmazonECSCreated",
        )?.Value;
        const volumeId = volume.VolumeId;
        if (!taskARN || !volumeId) continue;
        const taskId = taskARN.split("/")[2];

        volumes.push({
          volumeId,
          taskId,
        });
      }
    }
  } catch (e) {
    return { Error: { Code: "DescribeVolumesFailed", Value: `${e}` } };
  }

  volumes.sort((left, right) => left.taskId.localeCompare(right.taskId));

  const queries: cloudwatch.MetricDataQuery[] = volumes.flatMap((volume) => [
    {
      Id: `ops_${volume.taskId}`,
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EBS",
          MetricName: `Volume${typ}Ops`,
          Dimensions: [{ Name: "VolumeId", Value: volume.volumeId }],
        },
        Stat: "Sum",
        Period: event.GetMetricDataRequest.Period,
      },
    },
    {
      Id: `rate_${volume.taskId}`,
      Label: `IOPS ${volume.taskId}`,
      Expression: `ops_${volume.taskId} / PERIOD(ops_${volume.taskId})`,
    },
  ]);

  try {
    const dataResult = await cloudwatchClient.send(
      new cloudwatch.GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: new Date(event.GetMetricDataRequest.StartTime * 1000),
        EndTime: new Date(event.GetMetricDataRequest.EndTime * 1000),
      }),
    );

    return {
      Messages: dataResult.Messages,
      MetricDataResults: dataResult.MetricDataResults?.map((data) => ({
        StatusCode: data.StatusCode,
        Label: data.Label,
        Timestamps: data.Timestamps?.map((timestamp) =>
          Math.round(timestamp.valueOf() / 1000),
        ),
        Values: data.Values,
        Messages: data.Messages,
      })),
    };
  } catch (e) {
    return { Error: { Code: "GetMetricDataFailed", Value: `${e}` } };
  }
};

async function restatectl(args: string[]): Promise<string> {
  const result = await lambdaClient.send(
    new lambda.InvokeCommand({
      FunctionName: RESTATECTL_LAMBDA_ARN,
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

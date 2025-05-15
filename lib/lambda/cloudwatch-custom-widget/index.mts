import type { Context } from "aws-lambda";
import * as ec2 from "@aws-sdk/client-ec2";
import * as cloudwatch from "@aws-sdk/client-cloudwatch";

import { controlPanel, controlPanelRefresh } from "./control-panel.mjs";
import { ControlPanelInput } from "./readers.mjs";

const ec2Client = new ec2.EC2Client({});
const cloudwatchClient = new cloudwatch.CloudWatchClient({});

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
  | ControlPanelWidgetRefreshEvent
);

export type ControlPanelWidgetEvent = {
  command: "controlPanel";
  input: ControlPanelInput;
};

export type ControlPanelWidgetRefreshEvent = {
  command: "controlPanelRefresh";
};

export interface WidgetContext {
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
  forms: {
    all: {
      [k: string]: string | undefined;
    };
  };
  params: unknown;
  width: number;
  height: number;
}

const DOCS = `
## Display Restate cluster information
Retrieves Restate cluster information from restatectl and displays it
`;

export const handler = async (
  event: CustomDataSourceEvent | CustomDataSourceDescribeEvent | WidgetEvent,
  context: Context,
): Promise<CustomDataSourceResponse | CustomDataSourceDescribeResponse | string> => {
  console.log(event);
  if ("EventType" in event) {
    const eventType = event.EventType;
    if (eventType == "GetMetricData") {
      return await customDataSourceHandler(event);
    } else if (eventType == "DescribeGetMetricData") {
      return await customDataSourceDescribeHandler();
    } else {
      throw new Error(`Unexpected event type ${eventType}`);
    }
  } else if ("widgetContext" in event) {
    return await widgetHandler(event, context);
  } else {
    throw new Error("Unexpected event payload");
  }
};

export const customDataSourceDescribeHandler = async (): Promise<CustomDataSourceDescribeResponse> => {
  return {
    Description: "Obtain Restate cluster metric data",
  };
};

export const widgetHandler = async (event: WidgetEvent, context: Context): Promise<string> => {
  if ("describe" in event && event.describe) {
    return DOCS;
  }

  if (!("command" in event)) throw new Error("Missing widget command");

  const command = event.command;
  switch (command) {
    case "echo":
      return event.echo || '<pre>No "echo" parameter specified</pre>';
    case "controlPanel":
      return await controlPanel(context, event.widgetContext, event);
    case "controlPanelRefresh":
      return await controlPanelRefresh(context, event.widgetContext);
    default:
      throw new Error(`Unexpected widget command: ${command}`);
  }
};

export const customDataSourceHandler = async (event: CustomDataSourceEvent): Promise<CustomDataSourceResponse> => {
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
        const taskARN = volume.Tags?.find((tag) => tag.Key == "AmazonECSCreated")?.Value;
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
        Timestamps: data.Timestamps?.map((timestamp) => Math.round(timestamp.valueOf() / 1000)),
        Values: data.Values,
        Messages: data.Messages,
      })),
    };
  } catch (e) {
    return { Error: { Code: "GetMetricDataFailed", Value: `${e}` } };
  }
};

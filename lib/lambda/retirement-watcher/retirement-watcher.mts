import type { EventBridgeEvent, SQSHandler } from "aws-lambda";
import * as ecs from "@aws-sdk/client-ecs";

/*
{
  "detail-type": "AWS Health Event",
  "resources": [
    "arn:aws:ecs:eu-central-1:211125428070:task/restate-bluegreen/30d5ec8ed94c4132a1dc9879332b8cbe",
  ],
  "detail": {
    "service": "ECS",
    "eventTypeCode": "AWS_ECS_TASK_PATCHING_RETIREMENT"
  }
}
*/

interface AWSHealthEvent {
  eventTypeCode: string;
}

const TAG_KEY = "restate:ecs-retirement:last-notification";

const CLUSTER_ARN = process.env["CLUSTER_ARN"];
if (!CLUSTER_ARN) throw new Error("Missing CLUSTER_ARN");

const client = new ecs.ECSClient({});

export const handler: SQSHandler = async (event) => {
  recordLoop: for (const record of event.Records) {
    let healthEvent: Partial<
      EventBridgeEvent<"AWS Health Event", AWSHealthEvent>
    >;

    console.log("Processing health event", record?.body);

    try {
      healthEvent = JSON.parse(record?.body);
    } catch (e) {
      console.log("Failed to parse record body; ignoring", record?.body);
      continue;
    }

    if (
      healthEvent?.detail?.eventTypeCode != "AWS_ECS_TASK_PATCHING_RETIREMENT"
    ) {
      console.log(
        "Unexpected eventTypeCode, will ignore this event:",
        healthEvent?.detail?.eventTypeCode,
      );
      continue;
    }

    if (!healthEvent?.time) {
      console.log("No time in health event; ignoring");
      continue;
    }

    if (!healthEvent?.resources?.length) {
      console.log("No resources in health event; ignoring");
      continue;
    }

    let eventTime: number;
    try {
      eventTime = Date.parse(healthEvent.time);
    } catch (e) {
      console.log(
        `Event has invalid timestamp, will ignore: ${healthEvent.time}`,
        e,
      );
      continue;
    }

    console.log(`Describing cluster ${CLUSTER_ARN}`);

    const describeClustersResponse = await client.send(
      new ecs.DescribeClustersCommand({
        clusters: [CLUSTER_ARN],
        include: ["TAGS"],
      }),
    );

    for (const failure of describeClustersResponse.failures ?? []) {
      throw new Error(
        `Failed to describe cluster ${failure.arn}: ${failure.reason} ${failure.detail}`,
      );
    }

    const cluster = describeClustersResponse.clusters?.find(
      (cluster) => cluster.clusterArn == CLUSTER_ARN,
    );

    if (!cluster) throw new Error("Cluster missing in describe response");

    const existingRetirementTimeString = cluster.tags?.find(
      (tag) => tag.key == TAG_KEY,
    )?.value;

    if (existingRetirementTimeString) {
      try {
        const existingRetirementTime = Date.parse(existingRetirementTimeString);
        if (existingRetirementTime > eventTime) {
          console.log(
            `Not updating cluster ${cluster.clusterArn} because it already has a later retirement notification time than this event`,
          );
          continue;
        }
        if (existingRetirementTime == eventTime) {
          console.log(
            `Not updating service ${cluster.clusterArn} because it already has this retirement notification time tagged`,
          );
          continue;
        }
      } catch (e) {
        console.log(
          `Ignoring existing retirement time ${existingRetirementTimeString} as it couldn't be parsed`,
        );
      }
    }

    const timeString = new Date(eventTime).toISOString();

    await client.send(
      new ecs.TagResourceCommand({
        resourceArn: cluster.clusterArn,
        tags: [
          {
            key: TAG_KEY,
            value: timeString,
          },
        ],
      }),
    );

    console.log(
      `Tagged ${cluster.clusterArn} with new retirement notification time ${timeString}`,
    );
  }
};

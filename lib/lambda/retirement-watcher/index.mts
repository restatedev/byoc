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

const TAG_KEY = "restate:retiring";

const client = new ecs.ECSClient({});

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    let healthEvent: Partial<
      EventBridgeEvent<"AWS Health Event", AWSHealthEvent>
    >;

    console.log("Processing health event", record?.body);

    try {
      healthEvent = JSON.parse(record?.body);
    } catch (e) {
      console.log("Failed to parse record body; ignoring", record?.body, e);
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

    if (!healthEvent?.resources?.length) {
      console.log("No resources in health event; ignoring");
      continue;
    }

    const tagPromises = healthEvent.resources.map((taskArn) =>
      client
        .send(
          new ecs.TagResourceCommand({
            resourceArn: taskArn,
            tags: [
              {
                key: TAG_KEY,
                value: "true",
              },
            ],
          }),
        )
        .then((result) => {
          console.log(`Tagged ${taskArn} as retiring`);
          return result;
        }),
    );

    await Promise.all(tagPromises);
  }
};

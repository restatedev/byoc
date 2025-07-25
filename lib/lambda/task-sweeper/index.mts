import { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
import {
  ECSClient,
  ListTasksCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  waitUntilTasksStopped,
} from "@aws-sdk/client-ecs";

const ecs = new ECSClient({});

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context,
) {
  console.log("CloudFormation event:", JSON.stringify(event, null, 2));

  try {
    if (event.RequestType === "Delete") {
      const clusterArn = event.ResourceProperties.ClusterArn;
      const taskDefinitionArn = event.ResourceProperties.TaskDefinitionArn;

      console.log(
        `Cleaning up tasks for cluster: ${clusterArn}, task definition: ${taskDefinitionArn}`,
      );

      const listResponse = await ecs.send(
        new ListTasksCommand({
          cluster: clusterArn,
        }),
      );

      if (listResponse.taskArns && listResponse.taskArns.length > 0) {
        const describeResponse = await ecs.send(
          new DescribeTasksCommand({
            cluster: clusterArn,
            tasks: listResponse.taskArns,
          }),
        );

        const tasksToStop =
          describeResponse.tasks?.filter(
            (task) => task.taskDefinitionArn === taskDefinitionArn,
          ) || [];

        console.log(`Found ${tasksToStop.length} tasks to stop`);

        for (const task of tasksToStop) {
          if (task.taskArn) {
            console.log(`Stopping task: ${task.taskArn}`);
            await ecs.send(
              new StopTaskCommand({
                cluster: clusterArn,
                task: task.taskArn,
                reason: "Stack deletion cleanup",
              }),
            );
          }
        }

        const taskArnsToWaitFor = tasksToStop
          .map((task) => task.taskArn)
          .filter((arn): arn is string => arn !== undefined);

        if (taskArnsToWaitFor.length > 0) {
          console.log(
            `Waiting for ${taskArnsToWaitFor.length} tasks to stop...`,
          );

          await waitUntilTasksStopped(
            {
              client: ecs,
              maxWaitTime: 120,
              minDelay: 5,
              maxDelay: 15,
            },
            {
              cluster: clusterArn,
              tasks: taskArnsToWaitFor,
            },
          );

          console.log("All tasks have stopped successfully");
        }
      }
    }

    await sendResponse(event, context, "SUCCESS", {});
  } catch (error) {
    console.error("Error:", error);
    await sendResponse(event, context, "FAILED", { Error: String(error) });
  }
}

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  responseStatus: string,
  responseData: unknown,
) {
  const responseBody = JSON.stringify({
    Status: responseStatus,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: responseData,
  });

  const url = event.ResponseURL;

  const requestOptions = {
    method: "PUT",
    headers: {
      "Content-Type": "",
      "Content-Length": responseBody.length.toString(),
    },
    body: responseBody,
  };

  try {
    const response = await fetch(url, requestOptions);
    console.log("Response sent successfully:", response.status);
  } catch (error) {
    console.error("Error sending response:", error);
  }
}

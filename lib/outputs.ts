import * as cdk from "aws-cdk-lib";
import { RestateEcsFargateCluster } from "./byoc";

export function createOutputs(byoc: RestateEcsFargateCluster) {
  new cdk.CfnOutput(byoc, "SecurityGroups", {
    description: "The security group IDs of the cluster",
    value: cdk.Fn.join(
      ",",
      byoc.securityGroups.map((sg) => sg.securityGroupId),
    ),
  });

  new cdk.CfnOutput(byoc, "IngressNetworkListener", {
    description: "The ARN of the network listener for the ingress port",
    value: byoc.listeners.ingress.listener.listenerArn,
  });

  new cdk.CfnOutput(byoc, "IngressNetworkTargetGroup", {
    description: "The ARN of the network target group for the ingress port",
    value: byoc.targetGroups.ingress.network.targetGroupArn,
  });

  new cdk.CfnOutput(byoc, "AdminNetworkListener", {
    description: "The ARN of the network listener for the admin port",
    value: byoc.listeners.admin.listener.listenerArn,
  });

  new cdk.CfnOutput(byoc, "AdminNetworkTargetGroup", {
    description: "The ARN of the network target group for the admin port",
    value: byoc.targetGroups.admin.network.targetGroupArn,
  });

  new cdk.CfnOutput(byoc, "NodeNetworkListener", {
    description: "The ARN of the network listener for the node port",
    value: byoc.listeners.node.listener.listenerArn,
  });

  new cdk.CfnOutput(byoc, "NodeNetworkTargetGroup", {
    description: "The ARN of the network target group for the node port",
    value: byoc.targetGroups.node.network.targetGroupArn,
  });
}

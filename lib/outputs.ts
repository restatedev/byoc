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

  // Only create listener output if listener exists (port not disabled)
  if (byoc.listeners.ingress.listener) {
    new cdk.CfnOutput(byoc, "IngressNetworkListener", {
      description: "The ARN of the network listener for the ingress port",
      value: byoc.listeners.ingress.listener.listenerArn,
    });
  }

  // Only create output if ingress NLB target group exists (not disabled)
  if (byoc.targetGroups.ingress.network) {
    new cdk.CfnOutput(byoc, "IngressNetworkTargetGroup", {
      description: "The ARN of the network target group for the ingress port",
      value: byoc.targetGroups.ingress.network.targetGroupArn,
    });
  }

  // Only create listener output if listener exists (port not disabled)
  if (byoc.listeners.admin.listener) {
    new cdk.CfnOutput(byoc, "AdminNetworkListener", {
      description: "The ARN of the network listener for the admin port",
      value: byoc.listeners.admin.listener.listenerArn,
    });
  }

  // Only create output if admin NLB target group exists (not disabled)
  if (byoc.targetGroups.admin.network) {
    new cdk.CfnOutput(byoc, "AdminNetworkTargetGroup", {
      description: "The ARN of the network target group for the admin port",
      value: byoc.targetGroups.admin.network.targetGroupArn,
    });
  }

  new cdk.CfnOutput(byoc, "NodeNetworkListener", {
    description: "The ARN of the network listener for the node port",
    value: byoc.listeners.node.listener.listenerArn,
  });

  new cdk.CfnOutput(byoc, "NodeNetworkTargetGroup", {
    description: "The ARN of the network target group for the node port",
    value: byoc.targetGroups.node.network.targetGroupArn,
  });
}

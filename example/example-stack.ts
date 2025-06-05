import { RestateBYOC } from "@restatedev/byoc";
import assert from "assert";
import * as cdk from "aws-cdk-lib";
import { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import { IRole } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class RestateClusterStack extends cdk.Stack {
  readonly vpc: IVpc;
  readonly adminUrl: string;
  readonly securityGroup: ISecurityGroup;
  readonly restateRole: IRole;

  constructor(scope: Construct, id: string, props: cdk.StackProps & { licenseKey: string }) {
    super(scope, id, props);

    // Override BYOC default Restate and Controller images:
    const restateImage = cdk.aws_ecs.ContainerImage.fromRegistry("ghcr.io/restatedev/restate:main");
    const controllerImage = cdk.aws_ecs.ContainerImage.fromRegistry(
      "ghcr.io/restatedev/restate-fargate-controller:main",
    );

    const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
      maxAzs: 3,
    });

    const restate = new RestateBYOC(this, "restate-byoc", {
      licenseID: props.licenseKey,
      vpc,
      controller: {
        _controllerImage: controllerImage,
      },
      statefulNode: {
        _restateImage: restateImage,
        resources: {
          cpu: 2048,
          memoryLimitMiB: 4096,
        },
        ebsVolume: {
          volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          sizeInGiB: 200,
        },
        environment: {
          DO_NOT_TRACK: "true",
        },
      },
      statelessNode: {
        _restateImage: restateImage,
        resources: {
          cpu: 2048,
          memoryLimitMiB: 4096,
        },
        environment: {
          DO_NOT_TRACK: "true",
        },
      },
      restateTasks: {
        enableExecuteCommand: true,
      },
      loadBalancer: {
        shared: {
          albProps: {
            vpc,
            internetFacing: true,
          },
          nlbProps: {
            vpc,
            internetFacing: true,
          },
        },
      },
    });

    // Allow ingress access from anywhere
    // restate.connections.allowFromAnyIpv4(Port.tcp(8080));

    // Outputs and cross-stack exports
    new cdk.CfnOutput(this, "ingressEndpoint", {
      value: `${restate.loadBalancer.ingress.protocol}://${restate.loadBalancer.ingress.lb.loadBalancerDnsName}:${restate.loadBalancer.ingress.port}`,
    });

    new cdk.CfnOutput(this, "restatectlLambdaArn", {
      value: restate.restatectl?.functionArn ?? "n/a",
    });

    new cdk.CfnOutput(this, "clusterName", {
      value: restate.clusterName,
    });

    new cdk.CfnOutput(this, "statelessServiceName", {
      value: restate.stateless.service.serviceName,
    });

    this.vpc = vpc;
    this.adminUrl = `${restate.loadBalancer.admin.protocol}://${restate.loadBalancer.admin.lb.loadBalancerDnsName}:${restate.loadBalancer.admin.port}`;
    this.restateRole = restate.restateTaskRole;

    assert(restate.securityGroups.length == 1);
    this.securityGroup = restate.securityGroups[0];
  }
}

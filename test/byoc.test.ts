import * as cdk from "aws-cdk-lib";
import "jest-cdk-snapshot";
import { RestateBYOC } from "../lib/byoc";

describe("BYOC", () => {
  test("Default parameters", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "default", { vpc });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With volume", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "with-volume", {
      vpc,
      statefulNode: {
        ebsVolume: {
          sizeInGiB: 200,
          volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With alb for admin", () => {
    const { stack, vpc } = createStack();

    const alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      stack,
      "alb",
      {
        vpc,
      },
    );

    new RestateBYOC(stack, "with-admin-alb", {
      vpc,
      loadBalancer: {
        admin: {
          applicationListenerProps: {
            loadBalancer: alb,
            protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
            port: 9070,
          },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With shared alb", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "with-shared-alb", {
      vpc,
      loadBalancer: {
        shared: {
          albProps: { vpc },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With too few AZs", () => {
    const { stack, vpc } = createStack();

    expect(
      () =>
        new RestateBYOC(stack, "too-few-azs", {
          vpc,
          subnets: {
            availabilityZones: stack.availabilityZones.slice(0, 2),
          },
        }),
    ).toThrow("not enough to satisfy zone replication property");
  });

  test("With one az", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "one-az", {
      vpc,
      statelessNode: {
        defaultReplication: { node: 2 },
      },
      subnets: {
        availabilityZones: [stack.availabilityZones[0]],
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Without metrics dashboard", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "without-metrics-dashboard", {
      vpc,
      monitoring: {
        dashboard: {
          metrics: {
            disabled: true,
          },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Without control panel", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "without-control-panel", {
      vpc,
      monitoring: {
        dashboard: {
          controlPanel: {
            disabled: true,
          },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Without custom widget lambda", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "without-custom-widget-lambda", {
      vpc,
      monitoring: {
        dashboard: {
          customWidgets: { disabled: true },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });
});

function createStack(): { stack: cdk.Stack; vpc: cdk.aws_ec2.IVpc } {
  const app = new cdk.App();

  const vpcStack = new cdk.Stack(app, "VPCStack", {
    env: { account: "account-id", region: "region" },
  });

  const vpc = new cdk.aws_ec2.Vpc(vpcStack, "vpc");

  const stack = new cdk.Stack(app, "RestateBYOC", {
    env: { account: "account-id", region: "region" },
  });

  return { stack, vpc };
}

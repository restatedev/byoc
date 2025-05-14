import * as cdk from "aws-cdk-lib";
import "jest-cdk-snapshot";
import { RestateBYOC } from "../lib/byoc";

describe("BYOC", () => {
  const licenseID = "foo";
  test("Default parameters", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "default", { vpc, licenseID });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With volume", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "with-volume", {
      vpc,
      licenseID,
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

  test("With shared alb", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "with-shared-alb", {
      vpc,
      licenseID,
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
          licenseID,
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
      licenseID,
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
      licenseID,
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
      licenseID,
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
      licenseID,
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

  test("Without service deployer", () => {
    const { stack, vpc } = createStack();

    const byoc = new RestateBYOC(stack, "without-service-deployer", {
      vpc,
      licenseID,
      serviceDeployer: {
        disabled: true,
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byoc.deployService("abc", null as any),
    ).toThrowErrorMatchingSnapshot();

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byoc.register(null as any),
    ).toThrowErrorMatchingSnapshot();
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

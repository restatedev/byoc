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
  });

  test("Without snapshot retention", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "without-snapshot-retention", {
      vpc,
      licenseID,
      controller: {
        snapshotRetention: {
          disabled: true,
        },
      },
    });
  });

  test("With admin ALB target group", () => {
    const { stack, vpc } = createStack();

    const byoc = new RestateBYOC(stack, "with-alb-target-groups", {
      vpc,
      licenseID,
    });

    const publicAlb =
      new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
        stack,
        "public-alb",
        {
          vpc,
          internetFacing: true,
        },
      );

    const certificate =
      cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        stack,
        "certificate",
        "cert-arn",
      );

    publicAlb.addListener("admin-listener", {
      port: 9070,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction:
        cdk.aws_elasticloadbalancingv2.ListenerAction.authenticateOidc({
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
          clientId: "client-id",
          clientSecret: cdk.SecretValue.secretsManager(
            "byoc-google-sso-client-secret",
          ),
          next: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([
            byoc.targetGroups.admin.application,
          ]),
        }),
    });

    // validate that reading it twice doesn't create resources twice
    const _ = byoc.targetGroups.admin.application;
  });

  test("With otel collector", () => {
    const { stack, vpc } = createStack();

    new RestateBYOC(stack, "with-otel-collector", {
      vpc,
      licenseID,
      monitoring: {
        otelCollector: {
          enabled: true,
          configuration: {
            exporters: {
              awsemf: {
                namespace: "Restate/Metrics",
                log_group_name: "/restate/metrics",
              },
            },
            metricExporterIds: ["awsemf"],
          },
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

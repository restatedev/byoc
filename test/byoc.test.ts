import * as cdk from "aws-cdk-lib";
import "jest-cdk-snapshot";
import { RestateEcsFargateCluster } from "../lib/byoc";
import { aws_logs, aws_s3 } from "aws-cdk-lib";

describe("BYOC", () => {
  const licenseKey = "foo";
  test("Default parameters", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "default", { vpc, licenseKey });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With cluster name", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "with-cluster-name", {
      vpc,
      licenseKey,
      clusterName: "restate-byoc-cluster",
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With existing bucket", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "with-cluster-name", {
      vpc,
      licenseKey,
      objectStorage: {
        bucket: aws_s3.Bucket.fromBucketName(stack, "bucket", "bucket-name"),
        prefix: "restate/prefix",
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("With volume", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "with-volume", {
      vpc,
      licenseKey,
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
        new RestateEcsFargateCluster(stack, "too-few-azs", {
          vpc,
          licenseKey,
          subnets: {
            availabilityZones: stack.availabilityZones.slice(0, 2),
          },
        }),
    ).toThrow("not enough to satisfy zone replication property");
  });

  test("With one az", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "one-az", {
      vpc,
      licenseKey,
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

    new RestateEcsFargateCluster(stack, "without-metrics-dashboard", {
      vpc,
      licenseKey,
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

    new RestateEcsFargateCluster(stack, "without-control-panel", {
      vpc,
      licenseKey,
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

    new RestateEcsFargateCluster(stack, "without-custom-widget-lambda", {
      vpc,
      licenseKey,
      monitoring: {
        dashboard: {
          customWidgets: { disabled: true },
        },
      },
    });
  });

  test("Without snapshot retention", () => {
    const { stack, vpc } = createStack();

    new RestateEcsFargateCluster(stack, "without-snapshot-retention", {
      vpc,
      licenseKey,
      controller: {
        snapshotRetention: {
          disabled: true,
        },
      },
    });
  });

  test("With admin ALB target group", () => {
    const { stack, vpc } = createStack();

    const byoc = new RestateEcsFargateCluster(stack, "with-alb-target-groups", {
      vpc,
      licenseKey,
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

    new RestateEcsFargateCluster(stack, "with-otel-collector", {
      vpc,
      licenseKey,
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

  test("With specific SG and subnets", () => {
    const { stack, vpc } = createStack();

    const securityGroup = new cdk.aws_ec2.SecurityGroup(stack, "sg", {
      vpc,
    });

    new RestateEcsFargateCluster(stack, "with-vpc-subnet", {
      vpc,
      licenseKey,
      subnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
        availabilityZones: vpc.availabilityZones.slice(0, 2),
      },
      securityGroups: [securityGroup],
      statelessNode: {
        defaultReplication: { node: 2 },
      },
      monitoring: {
        dashboard: {
          customWidgets: {
            securityGroups: [securityGroup],
          },
        },
      },
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Log groups can be customized after creation", () => {
    const { stack, vpc } = createStack();

    const cluster = new RestateEcsFargateCluster(stack, "test", {
      vpc,
      licenseKey,
      logRetention: {
        ecsTasks: aws_logs.RetentionDays.ONE_YEAR,
        default: aws_logs.RetentionDays.SIX_MONTHS,
      },
    });

    const testRole = new cdk.aws_iam.Role(stack, "test-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    expect(cluster.logGroups.restate).toBeDefined();
    expect(cluster.logGroups.controller).toBeDefined();
    expect(cluster.logGroups.restatectl).toBeDefined();
    expect(cluster.logGroups.retirementWatcher).toBeDefined();
    expect(cluster.logGroups.customWidget).toBeDefined();

    cluster.logGroups.restate.grantRead(testRole);
    cluster.logGroups.controller.grantWrite(testRole);

    cluster.logGroups.controller.addMetricFilter("error-metric", {
      filterPattern: cdk.aws_logs.FilterPattern.literal("[level=ERROR]"),
      metricNamespace: "Restate/Controller",
      metricName: "Errors",
      metricValue: "1",
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Retirement watcher queue can be customized", () => {
    const { stack, vpc } = createStack();

    const cluster = new RestateEcsFargateCluster(stack, "test", {
      vpc,
      licenseKey,
      _useLocalArtifacts: true,
    });

    expect(cluster.retirementWatcher).toBeDefined();
    expect(cluster.retirementWatcher!.queue).toBeDefined();

    cluster.retirementWatcher!.queue.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal("events.amazonaws.com")],
        actions: ["sqs:SendMessage"],
        resources: [cluster.retirementWatcher!.queue.queueArn],
        conditions: {
          StringEquals: {
            "aws:SourceAccount": cdk.Aws.ACCOUNT_ID,
          },
        },
      }),
    );

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Set up custom ALB for authenticated access", () => {
    const { stack, vpc } = createStack();

    const cluster = new RestateEcsFargateCluster(stack, "test", {
      vpc,
      licenseKey,
    });

    const accessLogsBucket = new aws_s3.Bucket(stack, "alb-access-logs", {
      blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(365 * 5),
        },
      ],
    });

    const adminAlb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      stack,
      "admin-alb",
      {
        vpc,
        internetFacing: true,
      },
    );
    adminAlb.logAccessLogs(accessLogsBucket, "admin-alb");
    adminAlb.addListener("admin-listener", {
      port: 443,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [
        cdk.aws_certificatemanager.Certificate.fromCertificateArn(
          stack,
          "admin-cert",
          "arn:aws:acm:region:account-id:certificate/admin-cert-id",
        ),
      ],
      defaultAction:
        cdk.aws_elasticloadbalancingv2.ListenerAction.authenticateOidc({
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
          clientId: "client-id-from-google-cloud-console",
          clientSecret: cdk.SecretValue.secretsManager(
            "restate-google-sso-client-secret",
          ),
          next: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([
            // An ingress ALB can target `cluster.targetGroups.ingress.application` instead
            cluster.targetGroups.admin.application,
          ]),
        }),
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

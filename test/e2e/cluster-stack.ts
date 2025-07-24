import { RestateEcsFargateCluster } from "@restatedev/byoc";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import path from "path";
import * as restate_cdk from "@restatedev/restate-cdk";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class RestateCluster extends cdk.App {
  constructor(name: string, props: { licenseKey: string }) {
    super();

    new RestateClusterStack(this, name, {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
      ...props,
    });
  }
}

export class RestateClusterStack extends cdk.Stack {
  readonly adminUrl: string;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { licenseKey: string },
  ) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
      maxAzs: 3,
    });

    const bucket = new cdk.aws_s3.Bucket(this, "bucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const restate = new RestateEcsFargateCluster(this, "restate-cluster", {
      licenseKey: props.licenseKey,
      vpc,
      objectStorage: {
        bucket,
      },
      controller: {
        controllerImage: "ghcr.io/restatedev/restate-fargate-controller:main",
      },
      statefulNode: {
        restateImage: "ghcr.io/restatedev/restate:main",
        restateVersion: "1.4.x",
        resources: {
          cpu: 512,
          memoryLimitMiB: 1024,
        },
        ebsVolume: {
          volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          sizeInGiB: 20,
        },
        environment: {
          DO_NOT_TRACK: "true",
          RUST_LOG: "debug",
          RUST_BACKTRACE: "full",
          REVISION: this.node.tryGetContext("revision"),
        },
      },
      statelessNode: {
        restateImage: "ghcr.io/restatedev/restate:main",
        restateVersion: "1.4.x",
        resources: {
          cpu: 512,
          memoryLimitMiB: 1024,
        },
        environment: {
          DO_NOT_TRACK: "true",
          RUST_LOG: "debug",
          RUST_BACKTRACE: "full",
          REVISION: this.node.tryGetContext("revision"),
        },
      },
      restateTasks: {
        enableExecuteCommand: true,
      },
      loadBalancer: {
        shared: {
          nlbProps: {
            vpc,
            internetFacing: true,
            vpcSubnets: {
              subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
            },
          },
        },
      },
      _useLocalArtifacts: true,
    });

    // TODO: tighten up; the LB currently requires these - why are these rules not setup automatically?
    restate.connections.allowFromAnyIpv4(cdk.aws_ec2.Port.tcp(8080));
    restate.connections.allowFromAnyIpv4(cdk.aws_ec2.Port.tcp(9070));
    restate.connections.allowFromAnyIpv4(cdk.aws_ec2.Port.tcp(5122));

    const handler = new cdk.aws_lambda_nodejs.NodejsFunction(
      this,
      "ServiceHandler",
      {
        runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, "lambda/handler.ts"),
        architecture: cdk.aws_lambda.Architecture.ARM_64,
        bundling: {
          minify: true,
          sourceMap: true,
        },
      },
    );

    const invokerRole = new cdk.aws_iam.Role(this, "InvokerRole", {
      assumedBy: restate.restateTaskRole,
    });
    const restateEnvironment = restate_cdk.RestateEnvironment.fromAttributes({
      adminUrl: restate.adminUrl,
      invokerRole,
    });
    const deployer = new restate_cdk.ServiceDeployer(this, "Deployer", {
      vpc,
      securityGroups: restate.securityGroups,
    });
    deployer.register(handler.currentVersion, restateEnvironment);

    new cdk.CfnOutput(this, "loadBalancerDnsName", {
      value: restate.listeners.ingress.lb.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, "ingressEndpointUrl", {
      value: `${restate.listeners.ingress.protocol}://${restate.listeners.ingress.lb.loadBalancerDnsName}:${restate.listeners.ingress.port}`,
    });
    new cdk.CfnOutput(this, "adminEndpointUrl", {
      value: `${restate.listeners.admin.protocol}://${restate.listeners.admin.lb.loadBalancerDnsName}:${restate.listeners.admin.port}`,
    });
    new cdk.CfnOutput(this, "restatectlLambdaArn", {
      value: restate.restatectl?.functionArn ?? "n/a",
    });
    new cdk.CfnOutput(this, "clusterName", { value: restate.clusterName });

    // TODO: some of this cleanup assistance should probably move into the BYOC construct
    //
    // Make sure to clean up if the controller shuts down early, or we won't be able to delete the cluster
    const taskCleanupLambda = new cdk.aws_lambda_nodejs.NodejsFunction(
      this,
      "TaskCleanupLambda",
      {
        runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, "lambda/task-cleanup.ts"),
        architecture: cdk.aws_lambda.Architecture.ARM_64,
        timeout: cdk.Duration.minutes(5),
        initialPolicy: [
          // TODO: tighten up policy
          new cdk.aws_iam.PolicyStatement({
            actions: ["ecs:ListTasks", "ecs:StopTask", "ecs:DescribeTasks"],
            resources: ["*"],
          }),
        ],
        bundling: {
          externalModules: ["@aws-sdk"],
        },
      },
    );
    new cdk.CustomResource(this, "stateful-task-sweeper", {
      serviceToken: taskCleanupLambda.functionArn,
      properties: {
        ClusterArn: restate.ecsCluster.clusterArn,
        TaskDefinitionArn: restate.stateful.taskDefinition.taskDefinitionArn,
      },
    });
    // Retain bucket until the cluster is fully deleted
    restate.ecsCluster.node.addDependency(bucket);
  }
}

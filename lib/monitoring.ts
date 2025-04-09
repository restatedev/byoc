import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import {
  DEFAULT_CONTROLLER_CPU,
  DEFAULT_CONTROLLER_MEMORY_LIMIT_MIB,
  DEFAULT_RESTATE_CPU,
  DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
  DEFAULT_STATEFUL_NODES_PER_AZ,
  DEFAULT_STATELESS_DESIRED_COUNT,
  RestateBYOCMonitoringProps,
  RestateBYOCProps,
} from "./props";
import { RESTATE_LOGO } from "./logo";

export function createMonitoring(
  scope: Construct,
  cluster: cdk.aws_ecs.ICluster,
  statelessTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  statefulTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  controllerTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  restatectlLambda?: cdk.aws_lambda.IFunction,
  props?: RestateBYOCProps,
): {
  metricsDashboard?: cloudwatch.Dashboard;
  controlPanelDashboard?: cloudwatch.Dashboard;
  customWidgetFn?: cdk.aws_lambda.IFunction;
} {
  const customWidgetFn = createCustomWidgetLambda(
    scope,
    restatectlLambda,
    props?.monitoring,
  );

  let controlPanelDashboard: cloudwatch.Dashboard | undefined;
  if (customWidgetFn) {
    if (!props?.monitoring?.dashboard?.controlPanel) {
      controlPanelDashboard = new cloudwatch.Dashboard(scope, "control-panel");
      cdk.Tags.of(controlPanelDashboard).add(
        "Name",
        controlPanelDashboard.node.path,
      );

      controlPanelDashboard.addWidgets(
        new cloudwatch.CustomWidget({
          title: "",
          functionArn: customWidgetFn.functionArn,
          width: 24,
          height: 24,
          params: {
            command: "controlPanel",
          },
        }),
      );
    }
  }

  const metricsDashboard = createMetricsDashboard(
    scope,
    cluster,
    statelessTaskDefinition,
    statefulTaskDefinition,
    controllerTaskDefinition,
    customWidgetFn,
    props,
  );

  return { metricsDashboard, controlPanelDashboard, customWidgetFn };
}

export function createMetricsDashboard(
  scope: Construct,
  cluster: cdk.aws_ecs.ICluster,
  statelessTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  statefulTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  controllerTaskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  customWidgetFn?: cdk.aws_lambda.IFunction,
  props?: RestateBYOCProps,
): cloudwatch.Dashboard | undefined {
  if (props?.monitoring?.dashboard?.metrics?.disabled) return;

  const metricsDashboard = new cloudwatch.Dashboard(scope, "metrics");
  cdk.Tags.of(metricsDashboard).add("Name", metricsDashboard.node.path);

  const cpuWidget = (title: string, taskFamily: string, cpuLimit: number) =>
    new cloudwatch.GraphWidget({
      title,
      view: cloudwatch.GraphWidgetView.TIME_SERIES,
      left: [
        new cloudwatch.MathExpression({
          expression: `cpu / 1024`,
          label: "CPU",
          usingMetrics: {
            cpu: new cloudwatch.MathExpression({
              expression: `SELECT AVG(CpuUtilized) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily,TaskId) WHERE TaskDefinitionFamily = '${taskFamily}' GROUP BY TaskId`,
            }),
          },
        }),
      ],
      width: 12,
      height: 6,
      leftYAxis: {
        label: "vCPUs",
        showUnits: false,
      },
      leftAnnotations: [
        {
          value: cpuLimit / 1024,
          label: "Limit",
        },
      ],
    });

  const memoryWidget = (
    title: string,
    taskFamily: string,
    memoryLimit: number,
  ) =>
    new cloudwatch.GraphWidget({
      title,
      view: cloudwatch.GraphWidgetView.TIME_SERIES,
      left: [
        new cloudwatch.MathExpression({
          expression: `memory / 1024`,
          label: "Memory",
          usingMetrics: {
            memory: new cloudwatch.MathExpression({
              expression: `SELECT AVG(MemoryUtilized) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily,TaskId) WHERE TaskDefinitionFamily = '${taskFamily}' GROUP BY TaskId`,
            }),
          },
        }),
      ],
      width: 12,
      height: 6,
      leftYAxis: {
        label: "GiB",
        showUnits: false,
      },
      leftAnnotations: [
        {
          value: memoryLimit / 1024,
          label: "Limit",
        },
      ],
    });

  const networkWidget = (title: string, taskFamily: string, typ: "Tx" | "Rx") =>
    new cloudwatch.GraphWidget({
      title: title,
      view: cloudwatch.GraphWidgetView.TIME_SERIES,
      left: [
        new cloudwatch.MathExpression({
          expression: `SELECT AVG(Network${typ}Bytes) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily,TaskId) WHERE TaskDefinitionFamily = '${taskFamily}' GROUP BY TaskId`,
          label: typ,
        }),
      ],
      width: 12,
      height: 6,
      leftYAxis: {
        label: "Bytes/sec",
        showUnits: false,
      },
    });

  const ebsVolume = props?.statefulNode?.ebsVolume;
  const volumeSize = ebsVolume?.sizeInGiB ?? 200;

  var iopsLimit: number;
  var throughputLimit: number;
  switch (ebsVolume?.volumeType) {
    case undefined: // default ephemeral volume
      iopsLimit = 600;
      throughputLimit = 150;
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.IO1:
      if (!ebsVolume?.iops)
        throw new Error("io1 volumes must have an iops configured");
      iopsLimit = ebsVolume.iops;
      const limit256 = Math.min(iopsLimit / 2000, 500);
      const limit16 = Math.min(iopsLimit / 64000, 1000);
      throughputLimit = Math.max(limit256, limit16);
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.IO2:
      if (!ebsVolume?.iops)
        throw new Error("io2 volumes must have an iops configured");
      iopsLimit = ebsVolume.iops;
      throughputLimit = Math.min(iopsLimit / 4, 4000);
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.GP2:
      iopsLimit = Math.min(volumeSize * 3, 16000);
      throughputLimit = Math.max(Math.min(iopsLimit / 4, 250), 128);
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.GP3:
      iopsLimit = ebsVolume.iops ?? 3000;
      throughputLimit = ebsVolume?.throughput ?? 125;
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.ST1:
      throughputLimit = Math.min((ebsVolume.sizeInGiB * 40) / 1000, 500);
      iopsLimit = throughputLimit; // assumes 1M i/o
      break;
    case cdk.aws_ec2.EbsDeviceVolumeType.SC1:
      throughputLimit = Math.min((ebsVolume.sizeInGiB * 12) / 1000, 192);
      iopsLimit = throughputLimit; // assumes 1M i/o
      break;
    default:
      throw new Error(`Unexpected EBS volume type: ${ebsVolume?.volumeType}`);
  }

  const storageThroughputWidget = (title: string, typ: "Write" | "Read") =>
    new cloudwatch.GraphWidget({
      title: title,
      view: cloudwatch.GraphWidgetView.TIME_SERIES,
      left: [
        new cloudwatch.MathExpression({
          expression: `RATE(count) / 1048576`,
          label: typ,
          usingMetrics: {
            count: new cloudwatch.MathExpression({
              expression: `SELECT MAX(Storage${typ}Bytes) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily,TaskId) WHERE TaskDefinitionFamily = '${statefulTaskDefinition.family}' GROUP BY TaskId`,
            }),
          },
        }),
      ],
      width: 8,
      height: 6,
      leftYAxis: {
        label: "MiB/sec",
        showUnits: false,
      },
      leftAnnotations: [
        {
          value: throughputLimit,
          label: "Limit",
          visible: false, // disable by default because it skews the graph so much
        },
      ],
    });

  const volumeUsageWidget = ebsVolume
    ? new cloudwatch.GraphWidget({
        title: `EBS Volume Usage (Total size ${volumeSize}GiB)`,
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
        left: [
          new cloudwatch.MathExpression({
            expression: `SELECT MAX(EBSFilesystemUtilized) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily,VolumeName) WHERE TaskDefinitionFamily = '${statefulTaskDefinition.family}' GROUP BY VolumeName`,
            label: "Usage",
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: {
          label: "GiB",
          showUnits: false,
        },
        leftAnnotations: [
          {
            value: volumeSize,
            label: "Volume size",
            visible: false, // disable by default because it skews the graph so much
          },
        ],
      })
    : new cloudwatch.GraphWidget({
        title: `Ephemeral Volume Usage (Total size ${volumeSize}GiB)`,
        left: [
          new cloudwatch.MathExpression({
            expression: `SELECT MAX(EphemeralStorageUtilized) FROM SCHEMA("ECS/ContainerInsights", ClusterName,TaskDefinitionFamily) WHERE TaskDefinitionFamily = '${statefulTaskDefinition.family}'`,
            label: "Usage",
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: {
          label: "GiB",
          showUnits: false,
        },
        leftAnnotations: [
          {
            value: volumeSize,
            label: "Volume size",
            visible: false, // disable by default because it skews the graph so much
          },
        ],
        liveData: false,
      });

  const logsWidget = (
    title: string,
    taskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  ) => {
    if (
      taskDefinition.defaultContainer?.logDriverConfig?.logDriver ==
        "awslogs" &&
      taskDefinition.defaultContainer.logDriverConfig.options?.["awslogs-group"]
    ) {
      const logsGroup =
        taskDefinition.defaultContainer.logDriverConfig.options[
          "awslogs-group"
        ];
      const logsRegion: string | undefined =
        taskDefinition.defaultContainer.logDriverConfig.options[
          "awslogs-region"
        ];
      return [
        new cloudwatch.LogQueryWidget({
          title,
          width: 24,
          height: 6,
          logGroupNames: [logsGroup],
          region: logsRegion,
          queryString: `fields @logStream, @timestamp, level, fields.message, target
          | sort @timestamp desc
          | limit 500`,
        }),
      ];
    } else {
      return [];
    }
  };

  let iopsWidgets: cloudwatch.IWidget[] = [];
  if (customWidgetFn) {
    if (props?.statefulNode?.ebsVolume) {
      const iopsWidget = (typ: "Read" | "Write") =>
        new cloudwatch.GraphWidget({
          title: `EBS Volume ${typ} IOPS (Limited to ${iopsLimit})`,
          left: [
            new cloudwatch.MathExpression({
              label: "",
              expression: `LAMBDA("${customWidgetFn.functionName}", "volumeIOPs", "${cluster.clusterName}", "${typ}")`,
            }),
          ],
          width: 12,
          height: 6,
          leftYAxis: {
            label: "IOPS",
            showUnits: false,
          },
          leftAnnotations: [
            {
              label: "Limit",
              value: iopsLimit,
              visible: false, // disable by default because it skews the graph so much
            },
          ],
        });

      iopsWidgets = [iopsWidget("Write"), iopsWidget("Read")];
    }
  }

  metricsDashboard.addWidgets(
    ...[
      cpuWidget(
        "Stateless CPU",
        statelessTaskDefinition.family,
        props?.statelessNode?.resources?.cpu ?? DEFAULT_RESTATE_CPU,
      ),
      memoryWidget(
        "Stateless Memory",
        statelessTaskDefinition.family,
        props?.statelessNode?.resources?.memoryLimitMiB ??
          DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
      ),

      networkWidget(
        "Stateless Network Tx",
        statelessTaskDefinition.family,
        "Tx",
      ),
      networkWidget(
        "Stateless Network Rx",
        statelessTaskDefinition.family,
        "Rx",
      ),
    ],
    ...logsWidget("Stateless Logs", statelessTaskDefinition),
    ...[
      cpuWidget(
        "Stateful CPU",
        statefulTaskDefinition.family,
        props?.statefulNode?.resources?.cpu ?? DEFAULT_RESTATE_CPU,
      ),
      memoryWidget(
        "Stateful Memory",
        statefulTaskDefinition.family,
        props?.statefulNode?.resources?.memoryLimitMiB ??
          DEFAULT_RESTATE_MEMORY_LIMIT_MIB,
      ),

      networkWidget("Stateful Network Tx", statefulTaskDefinition.family, "Tx"),
      networkWidget("Stateful Network Rx", statefulTaskDefinition.family, "Rx"),
    ],
    ...logsWidget("Stateful Logs", statefulTaskDefinition),
    ...[
      volumeUsageWidget,
      storageThroughputWidget(
        `Volume Write Throughput (Limited to ${throughputLimit} MiB/sec)`,
        "Write",
      ),
      storageThroughputWidget(
        `Volume Read Throughput (Limited to ${throughputLimit} MiB/sec)`,
        "Read",
      ),
    ],
    ...iopsWidgets,
    ...logsWidget("Controller Logs", controllerTaskDefinition),
  );

  return metricsDashboard;
}

function createCustomWidgetLambda(
  scope: Construct,
  restatectlLambda?: cdk.aws_lambda.IFunction,
  props?: RestateBYOCMonitoringProps,
): cdk.aws_lambda.Function | undefined {
  if (!restatectlLambda || props?.dashboard?.customWidgets?.disabled) return;

  const role =
    props?.dashboard?.customWidgets?.executionRole ??
    new cdk.aws_iam.Role(scope, "cloudwatch-custom-widget-execution-role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
    });

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "AWSLambdaBasicExecutionPermissions",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [restatectlLambda.functionArn],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "InvokeRestatectl",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["ec2:DescribeVolumes"],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "EC2ReadActions",
    }),
  );

  role.addToPrincipalPolicy(
    new cdk.aws_iam.PolicyStatement({
      actions: ["cloudwatch:GetMetricData"],
      resources: ["*"],
      effect: cdk.aws_iam.Effect.ALLOW,
      sid: "CloudWatchReadActions",
    }),
  );

  const fn = new cdk.aws_lambda.Function(
    scope,
    "cloudwatch-custom-widget-lambda",
    {
      role,
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: cdk.aws_lambda.Code.fromAsset(
        `${__dirname}/lambda/cloudwatch-custom-widget`,
      ),
      environment: {
        RESTATECTL_LAMBDA_ARN: restatectlLambda.functionArn,
      },
      timeout: cdk.Duration.seconds(60),
    },
  );
  cdk.Tags.of(fn).add("Name", fn.node.path);

  fn.addPermission("cloudwatch-custom-widget-lambda-allow-datasource", {
    principal: cdk.aws_iam.ServicePrincipal.fromStaticServicePrincipleName(
      "lambda.datasource.cloudwatch.amazonaws.com",
    ),
  });

  return fn;
}

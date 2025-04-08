import * as cdk from "aws-cdk-lib";

export const VOLUME_POLICY = new cdk.aws_iam.PolicyDocument({
  statements: [
    new cdk.aws_iam.PolicyStatement({
      sid: "CreateEBSManagedVolume",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:CreateVolume"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
      ],
      conditions: {
        ArnLike: {
          "aws:RequestTag/AmazonECSCreated": `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/*`,
        },
        StringEquals: {
          "aws:RequestTag/AmazonECSManaged": "true",
        },
      },
    }),
    // new cdk.aws_iam.PolicyStatement({
    //   sid: "CreateEBSManagedVolumeFromSnapshot",
    //   effect: cdk.aws_iam.Effect.ALLOW,
    //   actions: ["ec2:CreateVolume"],
    //   resources: ["arn:aws:ec2:*:*:snapshot/*"],
    // }),
    new cdk.aws_iam.PolicyStatement({
      sid: "TagOnCreateVolume",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:CreateTags"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
      ],
      conditions: {
        ArnLike: {
          "aws:RequestTag/AmazonECSCreated": `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/*`,
        },
        StringEquals: {
          "ec2:CreateAction": "CreateVolume",
          "aws:RequestTag/AmazonECSManaged": "true",
        },
      },
    }),
    new cdk.aws_iam.PolicyStatement({
      sid: "DescribeVolumesForLifecycle",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:DescribeVolumes", "ec2:DescribeAvailabilityZones"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "ec2:Region": cdk.Aws.REGION,
        },
      },
    }),
    new cdk.aws_iam.PolicyStatement({
      sid: "ManageEBSVolumeLifecycle",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
      ],
      conditions: {
        StringEquals: {
          "aws:ResourceTag/AmazonECSManaged": "true",
        },
      },
    }),
    new cdk.aws_iam.PolicyStatement({
      sid: "ManageVolumeAttachmentsForEC2",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:AttachVolume", "ec2:DetachVolume"],
      resources: [
        // has to be * for account id as the instance is not in our account, but is the fargate host, managed by AWS
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:instance/*`,
      ],
    }),
    new cdk.aws_iam.PolicyStatement({
      sid: "DeleteEBSManagedVolume",
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: ["ec2:DeleteVolume"],
      resources: [
        `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:volume/*`,
      ],
      conditions: {
        ArnLike: {
          "aws:ResourceTag/AmazonECSCreated": `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/*`,
        },
        StringEquals: {
          "aws:ResourceTag/AmazonECSManaged": "true",
        },
      },
    }),
  ],
});

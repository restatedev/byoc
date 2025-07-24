import * as cdk from "aws-cdk-lib";
import { RestateEcsFargateCluster } from "../lib/byoc";
import { Construct } from "constructs";
import type { EbsVolumeProps } from "../lib/props";

interface RestateBYOCStackProps extends cdk.StackProps {
  statelessNode: {
    resources: {
      cpu: number;
      memoryLimitMiB: number;
    };
  };
  statefulNode: {
    resources: {
      cpu: number;
      memoryLimitMiB: number;
    };
    ebsVolume: Omit<EbsVolumeProps, "sizeInGiB">;
  };
}

export class RestateBYOCStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RestateBYOCStackProps) {
    super(scope, id, props);

    const vpcId = new cdk.CfnParameter(this, "VpcId", {
      description: "Select the virtual private cloud (VPC).",
      type: "AWS::EC2::VPC::Id",
    });

    const availabilityZones = new cdk.CfnParameter(this, "AvailabilityZones", {
      description:
        "Three availability zones in which to run the cluster, as a comma-separated list. eg us-east-1a,us-east-1b,us-east-1c",
      type: "List<AWS::EC2::AvailabilityZone::Name>",
    });

    const subnets = new cdk.CfnParameter(this, "SubnetIds", {
      description:
        "Subnet IDs in which to run the cluster, as a comma-separated list. Private subnets require public internet connectivity via a NAT gateway. Please provide one per AZ. e.g. subnet-97bfc4cd,subnet-7ad7de32,subnet-d0930af3",
      type: "List<AWS::EC2::Subnet::Id>",
    });

    const vpc = cdk.aws_ec2.Vpc.fromVpcAttributes(this, "vpc", {
      vpcId: vpcId.valueAsString,
      availabilityZones: [
        cdk.Fn.select(0, availabilityZones.valueAsList),
        cdk.Fn.select(1, availabilityZones.valueAsList),
        cdk.Fn.select(2, availabilityZones.valueAsList),
      ],
      privateSubnetIds: [
        cdk.Fn.select(0, subnets.valueAsList),
        cdk.Fn.select(1, subnets.valueAsList),
        cdk.Fn.select(2, subnets.valueAsList),
      ],
    });

    const licenseKey = new cdk.CfnParameter(this, "LicenseKey", {
      description: "The License key provided to you by Restate.",
      type: "String",
      noEcho: true,
    });

    const volumeSize = new cdk.CfnParameter(this, "VolumeSize", {
      description:
        "The size in gigabytes of the EBS volumes attached to each stateless task.",
      default: 64,
      type: "Number",
    });

    const nodesPerAZ = new cdk.CfnParameter(this, "NodesPerAZ", {
      description: "The number of stateful Restate tasks to run in each AZ",
      default: 1,
      type: "Number",
    });

    new RestateEcsFargateCluster(this, "RestateBYOC", {
      vpc,
      licenseKey: licenseKey.valueAsString,
      statelessNode: {
        resources: props.statelessNode.resources,
        defaultReplication: { zone: 2 },
        defaultPartitions: 128,
        desiredCount: 3,
      },
      statefulNode: {
        nodesPerAz: nodesPerAZ.valueAsNumber,
        resources: props.statefulNode.resources,
        ebsVolume: {
          ...props.statefulNode.ebsVolume,
          sizeInGiB: volumeSize.valueAsNumber,
        },
      },
    });
  }
}

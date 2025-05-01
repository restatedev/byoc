# Restate Bring-your-own-cloud CDK construct

This package contains a construct suitable for deploying Restate on ECS Fargate using the BYOC controller.
The controller is not open source and currently must be provided in the form of a tarball.

## Example
```ts
interface BYOCStackProps extends cdk.StackProps {
  // Defaults to 'controller.tar' in the root of the repo
  controllerImageTarball?: string;
}

export class BYOCStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BYOCStackProps) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
      maxAzs: 3,
    });

    const byoc = new RestateBYOC(this, "restate-byoc", {
      vpc,
      statefulNode: {
        resources: {
          cpu: 2048,
          memoryLimitMiB: 4096,
        },
        ebsVolume: {
          volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          sizeInGiB: 200,
        },
      },
      statelessNode: {
        resources: {
          cpu: 2048,
          memoryLimitMiB: 4096,
        },
      },
      controller: {
        controllerImageTarball: props?.controllerImageTarball,
      },
    });
  }
}
```

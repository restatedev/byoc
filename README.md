# Restate Bring-your-own-cloud CDK construct

This package contains a construct suitable for deploying Restate on ECS Fargate using the BYOC controller.
The controller is not open source and a license ID must be provided for it to function. Please contact
[info@restate.dev](mailto:info@restate.dev) if you're interested in a license.

## Example
```shell
npm install @restatedev/byoc
```

```ts
interface BYOCStackProps extends cdk.StackProps {
}

export class BYOCStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: BYOCStackProps) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
      maxAzs: 3,
    });

    const byoc = new RestateBYOC(this, "restate-byoc", {
      licenseID: "this-was-provided-to-you-by-restate",
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
    });
  }
}
```

## Documentation
- [Authentication](./docs/authentication.md)
- [Service Deployer construct](./docs/deployer.md)


## Releasing
1. Update the NPM version in package.json and ensure it propagates to package-lock.json
2. Run `npm test`, confirming there are no other snapshot issues except the changed version, then `npm test -- -u` to
update the snapshots.
3. Push a tag eg `git tag v0.1.0 && git push origin v0.1.0`
4. Create a release from the tag
5. GHA will publish the NPM package once the release exists

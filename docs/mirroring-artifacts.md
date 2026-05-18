# Mirroring Lambda artifacts

The `RestateEcsFargateCluster` construct provisions a small number of Lambda functions whose code is fetched from a public Restate-owned S3 bucket at deploy time:

- the retirement watcher, which handles Fargate task retirement notifications from AWS Health,
- the `restatectl` Lambda wrapper, which lets you run `restatectl` commands against the cluster from outside the VPC,
- the CloudWatch custom widget handler used by the operational dashboards.

The default source is `restate-byoc-artifacts-public-<region>`. If your deployment account cannot reach that bucket (corporate egress restrictions, a VPC endpoint policy that limits S3 access to in-account buckets, an SCP, or a region that doesn't have a mirror) you can host the artifacts yourself and pass them to the construct via the `artifacts` prop.

This guide walks through the full process.

## Prerequisites

- An S3 bucket in your own AWS account that you will use as the mirror. It must be reachable from the account and region where you deploy the BYOC cluster. A bucket in the same region as the BYOC deployment is recommended to keep Lambda updates fast and avoid cross-region data transfer.
- A workstation or build host with the AWS CLI configured for both:
  - **Source** credentials that can read from `restate-byoc-artifacts-public-<region>` (anonymous reads are allowed; any identity with S3 access works).
  - **Destination** credentials that can write to your mirror bucket.
- The version of `@restatedev/byoc` your CDK project depends on.

## Step 1: Determine the BYOC version

Each release of `@restatedev/byoc` is paired with a fixed set of artifacts under a key prefix that matches the package version. From your CDK project root, read the resolved version directly from `node_modules`:

```sh
node -p "require('@restatedev/byoc/package.json').version"
```

(`npm ls @restatedev/byoc` also works but can be affected by workspace hoisting.)

Use this value wherever `<VERSION>` appears below. You will need to repeat the mirror step whenever you upgrade `@restatedev/byoc`.

## Step 2: Pick a source region

The public bucket is replicated across many AWS regions; pick one that your workstation can reach. If you are unsure, try a region close to you:

```sh
aws s3 ls s3://restate-byoc-artifacts-public-us-east-1/
aws s3 ls s3://restate-byoc-artifacts-public-eu-west-1/
```

Any region that responds successfully is fine to use as a source. Use that value as `<SOURCE_REGION>` below.

## Step 3: Discover which objects to mirror

List the objects published for your version:

```sh
aws s3 ls --recursive s3://restate-byoc-artifacts-public-<SOURCE_REGION>/<VERSION>/assets/
```

For BYOC `0.5.0` you should see three zip files:

```
<VERSION>/assets/cloudwatch-custom-widget.zip
<VERSION>/assets/restatectl.zip
<VERSION>/assets/retirement-watcher.zip
```

These are the artifacts the construct will look up at deploy time. The keys it reads are hardcoded in the construct as `<VERSION>/assets/{retirement-watcher,restatectl,cloudwatch-custom-widget}.zip`, so the listing above is the complete set; if a future BYOC version adds or removes an artifact, the new listing will reflect it.

## Step 4: Copy the artifacts into your mirror bucket

Sync the entire version prefix preserving keys exactly. The simplest approach is `aws s3 sync`:

```sh
VERSION=0.5.0
SOURCE_REGION=us-east-1
MIRROR_BUCKET=my-restate-byoc-artifacts-mirror

aws s3 sync \
  s3://restate-byoc-artifacts-public-${SOURCE_REGION}/${VERSION}/ \
  s3://${MIRROR_BUCKET}/${VERSION}/
```

Or copy each file individually if you prefer:

```sh
for KEY in retirement-watcher.zip restatectl.zip cloudwatch-custom-widget.zip; do
  aws s3 cp \
    s3://restate-byoc-artifacts-public-${SOURCE_REGION}/${VERSION}/assets/${KEY} \
    s3://${MIRROR_BUCKET}/${VERSION}/assets/${KEY}
done
```

Verify the mirror contents match what you expect:

```sh
aws s3 ls --recursive s3://${MIRROR_BUCKET}/${VERSION}/assets/
```

## Step 5: Wire the mirror into your CDK stack

Pass the mirror bucket to the construct via the `artifacts` prop:

```ts
import * as cdk from "aws-cdk-lib";
import { RestateEcsFargateCluster } from "@restatedev/byoc";

new RestateEcsFargateCluster(this, "restate-byoc", {
  licenseKey: "...",
  vpc,
  artifacts: {
    bucket: cdk.aws_s3.Bucket.fromBucketName(
      this,
      "restate-byoc-artifacts-mirror",
      "my-restate-byoc-artifacts-mirror",
    ),
  },
});
```

`cdk synth` will now reference the mirror bucket for the three Lambda functions. The key structure is unchanged: the construct will still read `<VERSION>/assets/<name>.zip`.

### Using a shared bucket with a key prefix

If you share a bucket with other artifacts and want to namespace the Restate ones, set `artifacts.prefix` (must end with `/`):

```ts
artifacts: {
  bucket: cdk.aws_s3.Bucket.fromBucketName(this, "shared", "my-shared-artifacts"),
  prefix: "restate-byoc/",
},
```

The construct will then read `restate-byoc/<VERSION>/assets/<name>.zip`. Mirror your files into the same layout in Step 4.

## Step 6: Bucket permissions

The principal that creates and updates the Lambda functions (typically the CloudFormation execution role for your deployment) must be able to `s3:GetObject` (and `s3:GetObjectVersion` if the bucket has versioning enabled) on the artifact keys. In the common case where the mirror bucket lives in the same AWS account as the BYOC deployment, the default account-level access is sufficient and no bucket policy is required.

If the mirror bucket is in a different account, add a bucket policy that scopes the grant to the deploying role. Prefer the CloudFormation execution role rather than the entire account root:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBYOCDeploymentReads",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<DEPLOYMENT_ACCOUNT_ID>:role/cdk-<QUALIFIER>-cfn-exec-role-<ACCOUNT>-<REGION>"
      },
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::my-restate-byoc-artifacts-mirror/*"
    }
  ]
}
```

(For CDK's default bootstrap, `<QUALIFIER>` is `hnb659fds`.) If you cannot easily identify the CFN execution role, falling back to `"AWS": "arn:aws:iam::<DEPLOYMENT_ACCOUNT_ID>:root"` works but grants any principal in the deployment account read access to your mirror.

## Upgrading

When you bump the `@restatedev/byoc` version in `package.json`:

1. Repeat Steps 1, 3, and 4 with the new version number so the new artifact keys are in your mirror.
2. Deploy the updated CDK stack. The construct picks up the new version automatically from the package metadata.

The old version's artifacts can be deleted from the mirror once no stack still references them.

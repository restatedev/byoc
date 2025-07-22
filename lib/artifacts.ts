import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "node:path";

export function getArtifacts(
  scope: Construct,
  version: string,
): Record<string, cdk.aws_lambda.Code> {
  const artifactsBucket = cdk.aws_s3.Bucket.fromBucketName(
    scope,
    "artifacts-bucket",
    `restate-byoc-artifacts-public-${cdk.Aws.REGION}`,
  );

  return {
    "retirement-watcher.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      `${version}/assets/retirement-watcher.zip`,
    ),
    "restatectl.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      `${version}/assets/restatectl.zip`,
    ),
    "cloudwatch-custom-widget.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      `${version}/assets/cloudwatch-custom-widget.zip`,
    ),
    "task-sweeper.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      `${version}/assets/task-sweeper.zip`,
    ),
  };
}

export function bundleArtifacts(): Record<string, cdk.aws_lambda.Code> {
  return {
    "retirement-watcher.zip": cdk.aws_lambda.Code.fromAsset(
      path.join(__dirname, "../dist/lambda/retirement-watcher"),
    ),
    "restatectl.zip": cdk.aws_lambda.Code.fromAsset(
      path.join(__dirname, "../lib/lambda/restatectl"),
    ),
    "cloudwatch-custom-widget.zip": cdk.aws_lambda.Code.fromAsset(
      path.join(__dirname, "../dist/lambda/cloudwatch-custom-widget"),
    ),
    "task-sweeper.zip": cdk.aws_lambda.Code.fromAsset(
      path.join(__dirname, "../dist/lambda/task-sweeper"),
    ),
  };
}

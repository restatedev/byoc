import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export function getArtifacts(scope: Construct, version: string) {
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
  };
}

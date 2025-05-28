import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export function getArtifacts(scope: Construct) {
  const artifactsBucket = cdk.aws_s3.Bucket.fromBucketName(
    scope,
    "artifacts-bucket",
    `restate-byoc-artifacts-public-${cdk.Aws.REGION}`,
  );

  return {
    "retirement-watcher.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      "retirement-watcher.zip",
      { objectVersion: "ClZUAUYCBbLZfRITyEMei7FyPp2VR0KP" },
    ),
    "restatectl.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      "restatectl.zip",
      {
        objectVersion: "0Uy2fINKlZKI0E2IPFouP2X8S0WGSabL",
      },
    ),
    "cloudwatch-custom-widget.zip": cdk.aws_lambda.Code.fromBucketV2(
      artifactsBucket,
      "cloudwatch-custom-widget.zip",
      {
        objectVersion: "kDpi8UidtYFFZTJ6Q.oxJ1jjfYCPCEvl",
      },
    ),
  };
}

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "node:path";

export type ArtifactsOverride =
  | { bucket: cdk.aws_s3.IBucket; prefix?: string }
  | { bundled: true };

export function getArtifacts(
  scope: Construct,
  version: string,
  override?: ArtifactsOverride,
): Record<string, cdk.aws_lambda.Code> {
  if (override && "bundled" in override) {
    return bundledArtifacts(version);
  }

  const bucket =
    override?.bucket ??
    cdk.aws_s3.Bucket.fromBucketName(
      scope,
      "artifacts-bucket",
      `restate-byoc-artifacts-public-${cdk.Aws.REGION}`,
    );
  const prefix = override?.prefix ?? "";

  return {
    "retirement-watcher.zip": cdk.aws_lambda.Code.fromBucketV2(
      bucket,
      `${prefix}${version}/assets/retirement-watcher.zip`,
    ),
    "restatectl.zip": cdk.aws_lambda.Code.fromBucketV2(
      bucket,
      `${prefix}${version}/assets/restatectl.zip`,
    ),
    "cloudwatch-custom-widget.zip": cdk.aws_lambda.Code.fromBucketV2(
      bucket,
      `${prefix}${version}/assets/cloudwatch-custom-widget.zip`,
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
  };
}

function bundledArtifacts(
  expectedVersion: string,
): Record<string, cdk.aws_lambda.Code> {
  let paths: {
    retirementWatcher: string;
    restatectl: string;
    cloudwatchCustomWidget: string;
  };
  let artifactsPkg: { version: string };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    paths = require("@restatedev/byoc-artifacts");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    artifactsPkg = require("@restatedev/byoc-artifacts/package.json");
  } catch {
    throw new Error(
      "`artifacts: { bundled: true }` requires the optional peer dependency " +
        "`@restatedev/byoc-artifacts` to be installed at the same version as " +
        "`@restatedev/byoc`. Run: npm install @restatedev/byoc-artifacts",
    );
  }
  if (artifactsPkg.version !== expectedVersion) {
    throw new Error(
      `@restatedev/byoc-artifacts@${artifactsPkg.version} is installed but ` +
        `@restatedev/byoc@${expectedVersion} requires an exact version match. ` +
        `Upgrade both packages together.`,
    );
  }
  return {
    "retirement-watcher.zip": cdk.aws_lambda.Code.fromAsset(
      paths.retirementWatcher,
    ),
    "restatectl.zip": cdk.aws_lambda.Code.fromAsset(paths.restatectl),
    "cloudwatch-custom-widget.zip": cdk.aws_lambda.Code.fromAsset(
      paths.cloudwatchCustomWidget,
    ),
  };
}

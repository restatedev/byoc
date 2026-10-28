#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bucket = "restate-byoc-artifacts-public-eu-central-1";
const region = "eu-central-1";
const objects = [
  ["cloudwatch-custom-widget.zip", "assets/cloudwatch-custom-widget.zip"],
  ["restatectl.zip", "assets/restatectl.zip"],
  ["retirement-watcher.zip", "assets/retirement-watcher.zip"],
  ["medium.template.json", "templates/medium.template.json"],
  ["xlarge.template.json", "templates/xlarge.template.json"],
];
const [operation, version, directory] = process.argv.slice(2);
if (
  !version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  )
) {
  throw new Error("Expected a package version without path components");
}

if (operation === "policy") {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject"],
        Resource: `arn:aws:s3:::${bucket}/${version}/*`,
      },
    ],
  });
  if (policy.length > 2048)
    throw new Error("Version exceeds the STS session-policy size limit");
  console.log(policy);
} else if (operation === "upload" && directory) {
  const temporary = mkdtempSync(join(tmpdir(), "byoc-publish-"));
  try {
    for (const [filename, suffix] of objects) {
      const source = join(directory, filename);
      if (!lstatSync(source).isFile())
        throw new Error(`Expected a regular file: ${source}`);
      const key = `${version}/${suffix}`;
      const args = [
        "--bucket",
        bucket,
        "--key",
        key,
        "--region",
        region,
        "--no-cli-pager",
      ];
      try {
        execFileSync(
          "aws",
          [
            "s3api",
            "put-object",
            ...args,
            "--body",
            source,
            "--if-none-match",
            "*",
            "--content-type",
            filename.endsWith(".json") ? "application/json" : "application/zip",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        console.log(`Published ${key}`);
      } catch (error) {
        if (
          !String((error as { stderr?: Buffer }).stderr).includes(
            "(PreconditionFailed)",
          )
        )
          throw error;
        const existing = join(temporary, filename);
        execFileSync("aws", ["s3api", "get-object", ...args, existing], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (!readFileSync(source).equals(readFileSync(existing)))
          throw new Error(`Refusing to replace different content at ${key}`);
        console.log(`Already published identical content: ${key}`);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else {
  throw new Error(
    "Usage: publish_artifacts.mts policy <version> | upload <version> <directory>",
  );
}

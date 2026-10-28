#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const outputDirectory = path.resolve(process.argv[2] ?? "publish/s3");
fs.mkdirSync(outputDirectory, { recursive: true });

function sourceFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(filename) : [filename];
    })
    .sort();
}

const archives = {
  "cloudwatch-custom-widget.zip": sourceFiles(
    "dist/lambda/cloudwatch-custom-widget",
  ).filter((filename) => filename.endsWith(".mjs")),
  "restatectl.zip": sourceFiles("lib/lambda/restatectl"),
  "retirement-watcher.zip": sourceFiles(
    "dist/lambda/retirement-watcher",
  ).filter((filename) => filename.endsWith(".mjs")),
};
for (const [name, files] of Object.entries(archives)) {
  if (files.length === 0) throw new Error(`No input files for ${name}`);
  const archive = path.resolve("byoc-artifacts", name);
  fs.rmSync(archive, { force: true });
  for (const filename of files)
    fs.utimesSync(
      filename,
      new Date("1980-01-01T00:00:00Z"),
      new Date("1980-01-01T00:00:00Z"),
    );
  execFileSync("zip", ["-X", "-j", archive, ...files], {
    stdio: "inherit",
    env: { ...process.env, TZ: "UTC" },
  });
  fs.copyFileSync(archive, path.join(outputDirectory, name));
}

for (const name of ["xlarge", "medium"]) {
  execFileSync(
    "npm",
    [
      "run",
      "cdk",
      "--",
      "--app",
      `./templates/${name}.ts`,
      "synth",
      "RestateBYOCStack",
    ],
    { stdio: "inherit" },
  );
  const template = JSON.parse(
    fs.readFileSync("cdk.out/RestateBYOCStack.template.json", "utf8"),
  );
  fs.writeFileSync(
    path.join(outputDirectory, `${name}.template.json`),
    JSON.stringify(removeBootstrapDependencies(template), null, 2),
  );
}

function removeBootstrapDependencies(templateJson: {
  Metadata?: { "aws:cdk:path"?: unknown };
  Parameters?: { [key: string]: { Description?: string } };
  Rules?: { [name: string]: unknown };
  Resources?: { [id: string]: { Metadata?: { [key: string]: unknown } } };
  Conditions?: { [id: string]: unknown };
  Outputs?: { [name: string]: unknown };
}): unknown {
  const modifiedTemplate = { ...templateJson };

  // 1. Remove CDK metadata
  delete modifiedTemplate.Metadata?.["aws:cdk:path"];

  // 2. Remove CDK-specific parameters (like BootstrapVersion)
  if (modifiedTemplate.Parameters) {
    Object.keys(modifiedTemplate.Parameters).forEach((paramName) => {
      if (
        paramName.includes("BootstrapVersion") ||
        modifiedTemplate.Parameters?.[paramName].Description?.includes("CDK")
      ) {
        delete modifiedTemplate.Parameters?.[paramName];
      }
    });
  }

  // 3. Remove CDK rule conditions (if any)
  if (modifiedTemplate.Rules) {
    Object.keys(modifiedTemplate.Rules).forEach((ruleName) => {
      if (ruleName.includes("CheckBootstrap")) {
        delete modifiedTemplate.Rules?.[ruleName];
      }
    });

    // If the rules object is now empty, remove it
    if (Object.keys(modifiedTemplate.Rules).length === 0) {
      delete modifiedTemplate.Rules;
    }
  }

  // 4. Remove CDK-specific resources
  if (modifiedTemplate.Resources) {
    Object.keys(modifiedTemplate.Resources).forEach((id) => {
      // Remove CDK-specific resources or resources that depend on bootstrap
      if (
        id.includes("CDKMetadata") ||
        id.startsWith("CDK") ||
        id.includes("CustomResource")
      ) {
        delete modifiedTemplate.Resources?.[id];
      }

      // For remaining resources, clean any CDK-specific properties
      if (modifiedTemplate.Resources?.[id]) {
        // Remove CDK path metadata
        if (modifiedTemplate.Resources[id].Metadata?.["aws:cdk:path"]) {
          delete modifiedTemplate.Resources[id].Metadata["aws:cdk:path"];
        }

        // If the metadata object is now empty, remove it
        if (
          modifiedTemplate.Resources[id].Metadata &&
          Object.keys(modifiedTemplate.Resources[id].Metadata).length === 0
        ) {
          delete modifiedTemplate.Resources[id].Metadata;
        }
      }
    });
  }

  // 5. Remove CDK-specific conditions
  if (modifiedTemplate.Conditions) {
    Object.keys(modifiedTemplate.Conditions).forEach((id) => {
      // Remove CDK-specific resources or resources that depend on bootstrap
      if (id.includes("CDKMetadata")) {
        delete modifiedTemplate.Conditions?.[id];
      }
    });

    // If the rules object is now empty, remove it
    if (Object.keys(modifiedTemplate.Conditions).length === 0) {
      delete modifiedTemplate.Conditions;
    }
  }

  // 5. Clean up condition references that may point to removed CDK conditions
  function cleanupConditionsInResource(obj: unknown) {
    if (!obj || typeof obj !== "object") return;

    // Handle arrays
    if (Array.isArray(obj)) {
      obj.forEach((item) => cleanupConditionsInResource(item));
      return;
    }

    // Process object properties
    for (const key in obj) {
      // Remove Condition references to CDK bootstrap conditions
      if (
        key === "Condition" &&
        typeof obj[key] === "string" &&
        (obj[key].includes("CDK") || obj[key].includes("Bootstrap"))
      ) {
        delete obj[key];
      } else {
        cleanupConditionsInResource(obj[key]);
      }
    }
  }

  cleanupConditionsInResource(modifiedTemplate.Resources);

  // 6. Remove any CDK-specific outputs
  if (modifiedTemplate.Outputs) {
    Object.keys(modifiedTemplate.Outputs).forEach((outputName) => {
      if (
        outputName.includes("CDK") ||
        outputName.includes("BootstrapVersion")
      ) {
        delete modifiedTemplate.Outputs?.[outputName];
      }
    });
  }

  return modifiedTemplate;
}

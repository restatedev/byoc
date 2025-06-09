#!/usr/bin/env node

import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import packageJson from "../package.json" with { type: "json" };

// --- begin configuration ---

const STACK_NAME = "RestateBYOCStack"; // The CDK stack to publish
const REGION = "eu-central-1"; // AWS region

// --- end configuration ---

async function publishStack(templateName: string) {
  try {
    const BUCKET_NAME = `restate-byoc-artifacts-public-${REGION}`;
    console.log(`Using hosting bucket: ${BUCKET_NAME}`);

    // Step 1: Upload the lambdas
    execSync(`./artifacts/upload.sh ${packageJson.version}`, {
      stdio: "inherit",
    });

    // Step 2: Initialize S3 client
    const s3Client = new S3Client({ region: REGION });

    // Verify bucket exists
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    } catch (err) {
      throw new Error(`Hosting bucket ${BUCKET_NAME} not accessible: ${err}`);
    }

    // Step 3: Synthesize the CDK stack
    console.log(`Synthesizing stack ${STACK_NAME}...`);
    execSync(
      `npm run cdk -- --app './templates/${templateName}.ts' synth ${STACK_NAME}`,
      {
        stdio: "inherit",
      },
    );

    // Step 4: Read the asset manifest
    const cdkOutDir = path.join(process.cwd(), "cdk.out");
    const assetManifestPath = path.join(cdkOutDir, `${STACK_NAME}.assets.json`);

    if (!fs.existsSync(assetManifestPath)) {
      throw new Error(`Asset manifest not found at ${assetManifestPath}`);
    }

    // Step 6: Update and upload the CloudFormation template
    const templatePath = path.join(cdkOutDir, `${STACK_NAME}.template.json`);
    const templateContent = fs.readFileSync(templatePath, "utf8");
    const template = JSON.parse(templateContent);

    // Remove CDK bootstrap dependencies and update asset references
    console.log("Removing CDK bootstrap dependencies from template...");
    const cleanTemplate = removeBootstrapDependencies(template);

    const modifiedTemplate = JSON.stringify(cleanTemplate, null, 2);

    // Upload the modified template
    const templateKey = `${packageJson.version}/templates/${templateName}.template.json`;
    console.log(
      `Uploading modified CloudFormation template to ${templateKey}...`,
    );
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: templateKey,
        Body: modifiedTemplate,
        ContentType: "application/json",
      }),
    );

    // Generate the CloudFormation quick-create URL
    const templateUrl = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${templateKey}`;
    const quickCreateUrl = `https://console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/create/review?templateURL=${encodeURIComponent(templateUrl)}&stackName=${STACK_NAME}`;

    console.log("\nDEPLOYMENT SUCCESSFUL!");
    console.log(`Template URL: ${templateUrl}`);
    console.log(`Quick Create URL: ${quickCreateUrl}`);
  } catch (err) {
    console.error("Error publishing stack:", err);
    throw err;
  }
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

await publishStack("xlarge");
await publishStack("medium");

import {
  StackSelectionStrategy,
  Toolkit,
  MemoryContext,
  ICloudAssemblySource,
} from "@aws-cdk/toolkit-lib";
import { RestateCluster } from "./cluster-stack";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const stackName = process.env.STACK_NAME ?? "e2e-fargate-cluster";
  const licenseKey = process.env.BYOC_LICENSE_KEY as string;

  const initialDeployment = await deployClusterStack({
    stackName,
    licenseKey,
    revision: 0,
  });

  const loadTestController = startLoadTest({
    ingressUrl: initialDeployment.ingressUrl,
  });

  // Kick off an update deployment while test is running
  await deployClusterStack({
    stackName,
    licenseKey,
    revision: 1,
  });

  const result = await stopLoadTest(loadTestController);
  if (result.success) {
    console.log("✅ Load test completed successfully");
  } else {
    console.error("❌ Load test failed");
  }
  console.log(
    `\n\nTest summary data:\n\n${JSON.stringify(result.summary, null, 2)}`,
  );

  // Teardown happens outside of this script
  process.exit(result.success ? 0 : 1);
}

interface StackDeployment {
  ingressUrl: string;
  cloudAssembly: ICloudAssemblySource;
}

async function deployClusterStack(clusterProps: {
  stackName: string;
  licenseKey: string;
  revision: number;
}): Promise<StackDeployment> {
  const toolkit = new Toolkit();
  const cloudAssembly = await toolkit.fromAssemblyBuilder(
    async (_) =>
      new RestateCluster(clusterProps.stackName, clusterProps).synth(),
    {
      outdir: path.join(__dirname, "../..", "cdk.out"),
      contextStore: new MemoryContext({ revision: `${clusterProps.revision}` }),
    },
  );
  const deployResult = await toolkit.deploy(cloudAssembly, {
    stacks: {
      strategy: StackSelectionStrategy.PATTERN_MUST_MATCH,
      patterns: [clusterProps.stackName],
    },
  });

  const clusterStack = deployResult.stacks[0];
  console.log(
    `✅ Deployed ${clusterProps.stackName} (${clusterStack.stackArn})`,
  );
  return {
    ingressUrl: clusterStack.outputs.ingressEndpointUrl,
    cloudAssembly,
  };
}

interface LoadTestResult {
  success: boolean;
  summary: object;
  error?: string;
}

interface LoadTestController {
  process: ChildProcessWithoutNullStreams;
  summaryFilePath: string;
}

function startLoadTest({
  ingressUrl,
}: {
  ingressUrl: string;
}): LoadTestController {
  const k6ScriptPath = path.join(__dirname, "k6-script.ts");
  const summaryFilePath = path.join(process.cwd(), "load-test-summary.json");

  if (fs.existsSync(summaryFilePath)) {
    fs.unlinkSync(summaryFilePath);
  }

  console.log(`🚀 Starting load test against ${ingressUrl}`);

  const k6Process = spawn(
    "k6",
    [
      "run",
      '--summary-trend-stats="min,med,p(90),p(99),p(99.9),p(99.99),max"',
      k6ScriptPath,
    ],
    {
      env: {
        ...process.env,
        RESTATE_INGRESS_URL: ingressUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  k6Process.stdout.on("data", (data) => {
    process.stdout.write(data);
  });

  k6Process.stderr.on("data", (data) => {
    process.stderr.write(data);
  });

  k6Process.on("error", (error) => {
    console.error(`Failed to start k6 process: ${error.message}`);
  });

  return {
    process: k6Process,
    summaryFilePath,
  };
}

async function stopLoadTest(
  controller: LoadTestController,
): Promise<LoadTestResult> {
  return new Promise((resolve) => {
    console.log("\n⏰ Sending SIGINT to k6 process...");
    controller.process.kill("SIGINT");

    controller.process.on("close", (code: number) => {
      try {
        let summary = {};

        if (fs.existsSync(controller.summaryFilePath)) {
          const summaryData = fs.readFileSync(
            controller.summaryFilePath,
            "utf8",
          );
          summary = JSON.parse(summaryData);

          const metricsData = summary as {
            metrics?: Record<
              string,
              {
                thresholds?: Record<string, { ok: boolean }>;
              }
            >;
          };

          const thresholds: Array<{
            metric: string;
            threshold: string;
            ok: boolean;
          }> = [];

          if (metricsData.metrics) {
            Object.entries(metricsData.metrics).forEach(
              ([metricName, metricData]) => {
                if (metricData.thresholds) {
                  Object.entries(metricData.thresholds).forEach(
                    ([thresholdName, thresholdData]) => {
                      thresholds.push({
                        metric: metricName,
                        threshold: thresholdName,
                        ok: thresholdData.ok,
                      });
                    },
                  );
                }
              },
            );
          }

          console.table(thresholds);

          console.log(`\n📊 Test Results:`);
          console.log(`   Total thresholds: ${thresholds.length}`);

          const passedThresholds = thresholds.filter((t) => t.ok).length;
          const failedThresholds = thresholds.filter((t) => !t.ok).length;

          console.log(`   Thresholds passed: ${passedThresholds}`);
          console.log(`   Thresholds failed: ${failedThresholds}`);

          thresholds.forEach((threshold) => {
            const status = threshold.ok ? "✅" : "❌";
            console.log(
              `   ${status} ${threshold.metric}: ${threshold.threshold}`,
            );
          });

          const success =
            thresholds.length > 0 && thresholds.every((t) => t.ok);

          console.log(`   Exit code: ${code}`);
          console.log(`   Success: ${success}`);

          resolve({
            success,
            summary,
            error: success
              ? undefined
              : `Test validation failed: ${failedThresholds} failed thresholds`,
          });
        } else {
          resolve({
            success: false,
            summary: {},
            error: "No summary file generated by k6",
          });
        }
      } catch (error) {
        resolve({
          success: false,
          summary: {},
          error: `Failed to parse k6 summary: ${error}`,
        });
      }
    });
  });
}

main();

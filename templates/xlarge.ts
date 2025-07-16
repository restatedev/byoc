#!/usr/bin/env -S npm run ts-node -- --prefer-ts-exts

import * as cdk from "aws-cdk-lib";
import { RestateBYOCStack } from "./base";

const app = new cdk.App();

new RestateBYOCStack(app, "RestateBYOCStack", {
  statefulNode: {
    resources: {
      cpu: 16384,
      memoryLimitMiB: 32768,
    },
    ebsVolume: {
      volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
      iops: 3000,
      throughput: 125,
    },
  },
  statelessNode: {
    resources: {
      cpu: 4096,
      memoryLimitMiB: 8192,
    },
  },
});

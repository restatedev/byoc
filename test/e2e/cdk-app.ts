#!/usr/bin/env npx tsx
//
// Local entrypoint for deploying the e2e test stack directly outside of test runner
//
import { RestateCluster } from "./cluster-stack";

new RestateCluster(`restate-byoc-${process.env.USER}`, {
  licenseKey: process.env.BYOC_LICENSE_KEY as string,
});

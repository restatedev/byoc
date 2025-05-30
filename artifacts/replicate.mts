// Use this script to do a one-off replication job after adding new regions

import {
  AccountClient,
  GetAccountInformationCommand,
} from "@aws-sdk/client-account";
import { CreateJobCommand, S3ControlClient } from "@aws-sdk/client-s3-control";

const primaryRegion = "eu-central-1";
const accountID = "654654156625";
const accountClient = new AccountClient({ region: primaryRegion });
const s3ControlClient = new S3ControlClient({ region: primaryRegion });

async function replicate() {
  const accountResponse = await accountClient.send(
    new GetAccountInformationCommand({}),
  );

  if (accountResponse.AccountId !== accountID)
    throw new Error(
      `Incorrect AWS profile used; account ID should be ${accountID}`,
    );

  const jobResponse = await s3ControlClient.send(
    new CreateJobCommand({
      AccountId: accountID,
      Operation: {
        S3ReplicateObject: {},
      },
      Report: {
        Enabled: false,
      },
      ManifestGenerator: {
        S3JobManifestGenerator: {
          ExpectedBucketOwner: accountID,
          SourceBucket: `arn:aws:s3:::restate-byoc-artifacts-public-${primaryRegion}`,
          EnableManifestOutput: false,
          Filter: {
            EligibleForReplication: true,
          },
        },
      },
      Priority: 1,
      RoleArn: `arn:aws:iam::${accountID}:role/restate-byoc-artifacts-replication`,
      ConfirmationRequired: false,
    }),
  );

  console.log("Created replication job", jobResponse.JobId);
}

await replicate();

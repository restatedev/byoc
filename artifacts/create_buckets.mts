// Use this script to add new regions after opting in to them for the account

import {
  AccountClient,
  GetAccountInformationCommand,
  ListRegionsCommand,
} from "@aws-sdk/client-account";
import {
  S3Client,
  HeadBucketCommand,
  NotFound,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketReplicationCommand,
  PutBucketVersioningCommand,
  BucketVersioningStatus,
  ReplicationRuleStatus,
  type ReplicationRule,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { DeleteMarkerReplicationStatus } from "@aws-sdk/client-s3-control";

const primaryRegion = "eu-central-1";
const accountID = "654654156625";
const accountClient = new AccountClient({ region: primaryRegion });

async function createBuckets() {
  const accountResponse = await accountClient.send(
    new GetAccountInformationCommand({}),
  );

  if (accountResponse.AccountId !== accountID)
    throw new Error(
      `Incorrect AWS profile used; account ID should be ${accountID}`,
    );

  const regionsResponse = await accountClient.send(
    new ListRegionsCommand({
      RegionOptStatusContains: ["ENABLED", "ENABLED_BY_DEFAULT"],
    }),
  );

  const regionNames: string[] =
    regionsResponse.Regions?.map((region) => region.RegionName)
      .filter((region) => region !== undefined)
      .sort() || [];

  if (!regionNames.includes(primaryRegion)) {
    throw new Error(
      `Configured primary region ${primaryRegion} is not found in AWS regions response`,
    );
  }

  for (const region of regionNames) {
    const bucketName = `restate-byoc-artifacts-public-${region}`;
    const s3Client = new S3Client({ region });

    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      console.log(`Bucket ${bucketName} already exists`);
    } catch (error) {
      if (!(error instanceof NotFound)) {
        console.error(`Error checking bucket ${bucketName}:`, error);
        throw error;
      }

      console.log(`Creating bucket ${bucketName}`);

      await s3Client.send(
        new CreateBucketCommand({
          Bucket: bucketName,
        }),
      );
    }

    await s3Client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: false,
          IgnorePublicAcls: false,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: false,
        },
      }),
    );

    await s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: BucketVersioningStatus.Enabled,
        },
      }),
    );

    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: ["s3:GetObject", "s3:GetObjectVersion"],
              Resource: [`arn:aws:s3:::${bucketName}/*`],
            },
          ],
        }),
      }),
    );
  }

  const primaryBucket = `restate-byoc-artifacts-public-${primaryRegion}`;

  const regionNamesWithoutPrimary = regionNames.filter(
    (region) => region != primaryRegion,
  );

  const s3Client = new S3Client({ region: primaryRegion });
  await s3Client.send(
    new PutBucketReplicationCommand({
      Bucket: primaryBucket,
      ReplicationConfiguration: {
        Role: `arn:aws:iam::${accountID}:role/restate-byoc-artifacts-replication`,
        Rules: regionNamesWithoutPrimary.map(
          (region, i) =>
            ({
              ID: region,
              Filter: {
                Prefix: "",
              },
              DeleteMarkerReplication: {
                Status: DeleteMarkerReplicationStatus.Enabled,
              },
              Priority: i + 1,
              Status: ReplicationRuleStatus.Enabled,
              Destination: {
                Bucket: `arn:aws:s3:::restate-byoc-artifacts-public-${region}`,
              },
            }) satisfies ReplicationRule,
        ),
      },
    }),
  );
}

await createBuckets();

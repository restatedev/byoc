# Publishing artifacts

The public S3 keys are part of the release contract: customers resolve `<version>/assets/*.zip` and `<version>/templates/*.template.json` without an object version ID. Published bytes must not change.

The publishing workflow builds, tests, prepares the three Lambda archives and two templates, and packs both npm packages in a job without OIDC permission. The S3 job runs only a dependency-free uploader, with AWS credentials passed to that step rather than exported to the job environment. Its session policy confines access to the selected version, while the role limits writes to the five approved object names. A separate npm job publishes the prepared tarballs with lifecycle scripts disabled, artifacts package first. It has no AWS credentials and cannot assume the upload role: the role trusts only the `byoc-artifact-publish` environment declared by the S3 job.

S3 uploads use `If-None-Match: *`. An existing object is accepted only after downloading and comparing the bytes; different content fails publication. The role also enforces conditional writes and denies deletion, including object versions. Multipart initiation is deliberately unsupported; all five files must fit a single S3 PUT. A conflicting release must get a new package version. Snapshot versions include the workflow run ID and attempt, so retries use a new snapshot prefix.

`artifacts/prepare_publish.mts` normalizes archive timestamps and packages once so the S3 and npm payloads share the same ZIP bytes. No preparation, installation, synthesis or npm lifecycle scripts execute in the credentialed S3 job.

## Initial rollout

The existing upload role and buckets are not managed by the AWS infrastructure CDK stacks. The reviewed role configuration is in `artifacts/publisher-policy.json` and `artifacts/publisher-trust-policy.json`; `artifacts/configure_publisher.mts` applies it to the existing role as an operator. Do not run `--apply` inside test or publication jobs.

Coordinate the workflow merge and role configuration while no publication is in flight. The old workflow cannot publish under the new conditional policy, and the new workflow cannot assume the old ref-based trust. Either order fails closed during the cutover; rerun a failed publication after both changes are ready.

Create the GitHub publishing environment with selected deployment branches/tags:

```sh
gh api --method PUT repos/restatedev/byoc/environments/byoc-artifact-publish \
  --input artifacts/publisher-environment.json
gh api --method POST repos/restatedev/byoc/environments/byoc-artifact-publish/deployment-branch-policies \
  -f name=main -f type=branch
gh api --method POST repos/restatedev/byoc/environments/byoc-artifact-publish/deployment-branch-policies \
  -f 'name=v*' -f type=tag
```

The role configuration command checks that the environment allows exactly `main` and `v*` tags before updating AWS trust. It rejects unexpected attached or inline policies. Save the current role and `upload` inline policy before applying:

```sh
export AWS_PROFILE=restate-cloud-production-admin
aws iam get-role --role-name restate-byoc-artifacts-upload > publisher-role-before.json
aws iam get-role-policy --role-name restate-byoc-artifacts-upload --policy-name upload > publisher-policy-before.json
node artifacts/configure_publisher.mts          # inspect without changing AWS
node artifacts/configure_publisher.mts --apply
```

Read back the role trust and inline policy, then run a publication and verify that only the S3 step receives AWS credentials. Confirm initial upload, identical retry and a refused differing-content retry. Do not restore unconditional writes to recover a failed release. Repair the configuration or publish a new version.

Bucket replication uses its own role and remains unchanged. Customer-managed mirrors also remain unchanged; these restrictions apply to the GitHub publisher's primary-bucket access. Administrators can still repair resources, so the restriction is not a substitute for protecting operator access or the reviewed publication workflow.

## Local preparation

After building and downloading `restatectl`, prepare without AWS credentials:

```sh
npm run prepare-publish
```

The five S3 payloads are under `publish/s3/`. The same three ZIPs are also placed in `byoc-artifacts/` for npm packaging. The dependency-free uploader accepts a package version and this directory; operator uploads must use a role subject to the same create-only policy:

```sh
node artifacts/publish_artifacts.mts upload 0.5.1 publish/s3
```

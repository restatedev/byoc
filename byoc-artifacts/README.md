# @restatedev/byoc-artifacts

Pre-built Lambda artifact zips shipped alongside [`@restatedev/byoc`](https://www.npmjs.com/package/@restatedev/byoc):

- `retirement-watcher.zip` - handles AWS Health Fargate task retirement notifications
- `restatectl.zip` - Lambda wrapper around `restatectl` that targets the cluster from outside the VPC
- `cloudwatch-custom-widget.zip` - handler for the CloudWatch operational dashboards

The version of this package must match `@restatedev/byoc` exactly. It is declared as an optional peer dependency, so npm will not install it automatically: opt in by adding both packages to your project at the same version.

```sh
npm install @restatedev/byoc @restatedev/byoc-artifacts
```

This package exists so that the construct can resolve the Lambda assets through the normal CDK asset pipeline (uploads to your own CDK bootstrap bucket at synth time) instead of pulling them from a Restate-owned public S3 bucket at deploy time. The S3 distribution remains available as an override; see the `artifacts` prop in `@restatedev/byoc`.

## Programmatic use

```js
const { retirementWatcher, restatectl, cloudwatchCustomWidget } = require("@restatedev/byoc-artifacts");
// each is an absolute filesystem path to a .zip file
```

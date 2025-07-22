# Service deployer

The @restatedev/cdk library ships with a `ServiceDeployer` construct which you can use to register lambdas against
your BYOC cluster. This is documented in the [CDK Docs](https://docs.restate.dev/deploy/lambda/cdk).

The BYOC cluster implements IRestateEnvironment from the cdk library, so it can be used as the target for a deployer.
However, the implementation uses the admin URL of the construct-managed load balancer, which defaults to an internal NLB.
Therefore the deployer should be placed in the same VPC and security groups so that it has network access to the admin URL.

```ts
// create a restate service as a nodejs lambda
const service = new NodejsFunction(scope, "service", {
  runtime: lambda.Runtime.NODEJS_LATEST,
  architecture: lambda.Architecture.ARM_64,
  entry: "handler", // use the path to your service handler
});

// create a Restate cluster
const cluster = new RestateEcsFargateCluster(this, "cluster", {
  vpc,
  ...,
});
// give the cluster permissions to invoke your lambda
service.grantInvoke(cluster)

// create a service deployer that is in the cluster vpc
const deployer = new restate.ServiceDeployer(this, "deployer", {
  vpc: cluster.vpc,
  vpcSubnets: cluster.vpcSubnets,
  securityGroups: cluster.securityGroups,
});
// register the current version of the service with restate
deployer.register(service.currentVersion, cluster);
```

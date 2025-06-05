# Authentication
By default, Restate will be served only on an internal NLB. This load balancer is required for the restatectl lambda
function to be able to reach Restate. Depending on your requirements you may want to expose ports 8080 or 9070 publicly via a separate load
balancer to make it easier for developers and end users to reach.

Authentication via OIDC or Cognito is strongly recommended for admin traffic (9070), as this
access allows services to be modified and internal state to be read.
For ingress traffic (8080 or 443) you may choose for services to enforce their own authentication and authorization.
Alternatively, an API gateway or ALB can be used to enforce token-based auth.

The construct creates application and network target groups for ingress and admin ports
(see property `targetGroups` or the corresponding cfn outputs).

## Securing the admin endpoint

In general to set up ALB authentication using OIDC or Cognito you will need:
1. A DNS name for your ALB, eg `restate.your-domain.dev`
2. An AWS Certificate Manager certificate for the DNS name
3. An OIDC endpoint, client ID, and client secret you can use to authenticate your users, eg from Google SSO,
   or a Cognito user pool (which itself supports various identity platforms).

When configuring your OIDC provider or Cognito, your allowed redirect URLs must include `https://restate.your-domain.dev:9070/oauth2/idpresponse`.
You can read more in the
[AWS docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html).

A Google SSO authentication setup is shown below.
```ts
const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
  maxAzs: 3,
});

const byoc = new RestateBYOC(this, "restate-byoc", {
  vpc,
  ...,
});

const publicAlb =
  new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
    this,
    "public-alb",
    {
      vpc,
      internetFacing: true,
    },
  );

const certificate =
  cdk.aws_certificatemanager.Certificate.fromCertificateArn(
    this,
    "certificate",
    certificateARN,
  );

publicAlb.addListener("admin-listener", {
  port: 9070,
  protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
  certificates: [certificate],
  defaultAction:
    cdk.aws_elasticloadbalancingv2.ListenerAction.authenticateOidc({
      issuer: "https://accounts.google.com",
      authorizationEndpoint:
        "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userInfoEndpoint:
        "https://openidconnect.googleapis.com/v1/userinfo",
      clientId:
        "client-id-from-google-cloud-console",
      // create the client secret as a plaintext secret in secrets manager for use here
      clientSecret: cdk.SecretValue.secretsManager(
        "byoc-google-sso-client-secret"
      ),
      next: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([
        // using the cfn template directly? set ...and reference the `AdminNetworkTargetGroup` output
        byoc.getAdminApplicationTargetGroup(),
      ]),
    }),
});
```

## Securing the ingress endpoint

Ingress traffic may not need to be exposed publicly if clients are likely to be inside AWS and can be networked directly to the default internal
load balancer. However, if you have clients elsewhere, you may wish to use an internet facing ALB or API Gateway for the Restate ingress,
and control access to it.

Of course, it is always possible for your Restate services themselves to enforce authentication, perhaps by checking for particular headers.
Where this is not convenient, AWS provides some authentication mechanisms we can use.

### API gateway authorizers

An AWS API gateway can be placed in front of the default internal NLB used for ingress traffic, allowing you to expose the ingress publicly while using
the various API gateway authentication mechanisms, such as JWT authorizers and Lambda authorizers. If using a Cognito JWT authorizer,
you can integrate with your existing redirect-driven user authentication mechanism if clients are in the browser, or for backend clients, Cognito
has a machine-to-machine (m2m) authentication mechanism, which you can read about
[here](https://aws.amazon.com/blogs/mt/configuring-machine-to-machine-authentication-with-amazon-cognito-and-amazon-api-gateway-part-2/).

A Cognito based m2m authentication setup is shown below.

```ts
const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
  maxAzs: 3,
});

const byoc = new RestateBYOC(this, "restate-byoc", {
  vpc,
  ...,
});

// Cognito M2M user pool setup
const userPool = new cdk.aws_cognito.UserPool(this, `user-pool`);
const accessScope = new cdk.aws_cognito.ResourceServerScope({
  scopeName: "access",
  scopeDescription: "Access to the Restate ingress",
});
const resourceServer = new cdk.aws_cognito.UserPoolResourceServer(
  this,
  "resource-server",
  {
    identifier: "ingress",
    userPool: userPool,
    scopes: [accessScope],
  },
);
const userPoolClient = new cdk.aws_cognito.UserPoolClient(
  this,
  `user-pool-client`,
  {
    userPool,
    generateSecret: true,
    enableTokenRevocation: true,
    oAuth: {
      flows: {
        clientCredentials: true,
      },
      scopes: [
        cdk.aws_cognito.OAuthScope.resourceServer(
          resourceServer,
          accessScope,
        ),
      ],
    },
  },
);
userPool.addDomain(`user-pool-domain`, {
  cognitoDomain: {
    domainPrefix: "restate-byoc-auth",
  },
});
const cognitoAuthorizer = new cdk.aws_apigatewayv2_authorizers.HttpJwtAuthorizer(
  "jwt-authorizer",
  `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
  { jwtAudience: [userPoolClient.userPoolClientId] },
);

// API gateway setup
const ingressApi = new cdk.aws_apigatewayv2.HttpApi(this, "ingress-api");
const ingressLink = ingressApi.addVpcLink({
  vpc,
  // using the cfn template directly? this is the `SecurityGroups` output
  securityGroups: byoc.securityGroups,
});
ingressApi.addRoutes({
  path: "/{proxy+}",
  authorizer: cognitoAuthorizer,
  integration: new cdk.aws_apigatewayv2_integrations.HttpNlbIntegration(
    "ingress-nlb",
    // using the cfn template directly? this is the `IngressNetworkListener` output
    byoc.listeners.ingress.listener,
    { vpcLink: ingressLink },
  ),
});
```

Once this is set up, clients can obtain tokens by providing the client ID and secret (get this from the Cognito UI) to the token domain of the Cognito-hosted oauth2 server:
```bash
curl -X POST \
  https://${USER_POOL_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com/oauth2/token \
  -d 'grant_type=client_credentials' \
  --user ${CLIENT_ID}:${CLIENT_SECRET}
```

They can then provide these tokens in requests to the public API gateway url, with the header `Authorization: Bearer <oauth token>`. Note the tokens will expire after a configurable
period, so clients must be capable of getting new tokens when needed.

### Bearer token

An ALB can be configured to require a particular header as a condition before routing to a target. Its strongly recommended that you use a HTTPS listener
in this case. Note that the bearer token will be visible in the AWS UI in the description of the ALB rules as AWS does not yet support using values directly
from secrets manager for this purpose.

```ts
const vpc = new cdk.aws_ec2.Vpc(this, "vpc", {
  maxAzs: 3,
});

const byoc = new RestateBYOC(this, "restate-byoc", {
  vpc,
  ...,
});

const publicAlb =
  new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
    this,
    "public-alb",
    {
      vpc,
      internetFacing: true,
    },
  );

const certificate =
  cdk.aws_certificatemanager.Certificate.fromCertificateArn(
    this,
    "certificate",
    certificateARN,
  );

const ingressListener = publicAlb.addListener("ingress-listener", {
  port: 443,
  protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
  certificates: [certificate],
});

ingressListener.addAction("default", {
  action: cdk.aws_elasticloadbalancingv2.ListenerAction.fixedResponse(401),
});

ingressListener.addAction("authorized", {
  action: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([
    // using the cfn template directly? this is the `IngressNetworkTargetGroup` output
    byoc.targetGroups.ingress.application,
  ]),
  priority: 1,
  conditions: [
    cdk.aws_elasticloadbalancingv2.ListenerCondition.httpHeader(
      "Authorization",
      [
        `Bearer ${cdk.SecretValue.secretsManager("byoc-ingress-alb-bearer-token").unsafeUnwrap()}`,
      ],
    ),
  ],
});
```

Other conditions may also be helpful, for example to restrict to certain source IPs.

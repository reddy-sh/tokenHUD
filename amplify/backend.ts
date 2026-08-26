import { defineBackend } from '@aws-amplify/backend';
import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import {
    AllowedMethods,
    CacheCookieBehavior,
    CacheHeaderBehavior,
    CachePolicy,
    CacheQueryStringBehavior,
    CachedMethods,
    Distribution,
    OriginRequestPolicy,
    PriceClass,
    ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { ARecord, AaaaRecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { auth } from './auth/resource';
import { api } from './functions/api/resource';

const backend = defineBackend({ auth, api });

/* ── billing tags ───────────────────────────────────────────────────── */

// Applied to every resource in every stack so Cost Explorer can filter and
// group by project. Tags propagate to all child constructs — DynamoDB, Lambda,
// CloudFront, Cognito, CloudWatch log groups, everything.
const projectTags: Record<string, string> = {
  project: 'tokenhud',
  environment: process.env.AWS_BRANCH ?? 'sandbox',
  'managed-by': 'amplify',
};
function tagStack(construct: import('constructs').Construct) {
  for (const [k, v] of Object.entries(projectTags)) Tags.of(construct).add(k, v);
}

// Tag the Amplify-managed auth and api stacks too.
tagStack(backend.auth.stack);
tagStack(backend.api.stack);

/* ── configuration ──────────────────────────────────────────────────── */

// api.tokenhud.com is created only when all three are set, which is what keeps
// `ampx sandbox` cheap and fast: a personal backend gets the raw function URL
// and no CloudFront distribution at all. Set these as environment variables on
// the Amplify Hosting branch, not here — an open-source checkout should not
// carry one account's hosted zone.
//
//   TOKENHUD_API_DOMAIN   api.tokenhud.com
//   TOKENHUD_ZONE_NAME    tokenhud.com
//   TOKENHUD_ZONE_ID      the Route 53 hosted zone id for that name
//
// The certificate is created in whatever region this backend deploys to, and
// CloudFront only accepts certificates from us-east-1 — so a branch that sets
// these must deploy to us-east-1.
const apiDomain = process.env.TOKENHUD_API_DOMAIN ?? '';
const zoneName = process.env.TOKENHUD_ZONE_NAME ?? '';
const zoneId = process.env.TOKENHUD_ZONE_ID ?? '';
const wantsDomain = Boolean(apiDomain && zoneName && zoneId);

// Which origins may read an authenticated response. Not a wildcard: these
// routes carry a bearer token, and a page on any origin being able to read the
// answer to a request it made with somebody's ID token is the exact thing the
// same-origin policy exists to prevent. The public leaderboard opts out of
// this list in http.ts, deliberately and in one place.
const origins = [
  ...(process.env.TOKENHUD_SITE_URL
    ? [process.env.TOKENHUD_SITE_URL.replace(/\/+$/, '')]
    : ['https://tokenhud.com', 'https://www.tokenhud.com']),
  'http://localhost:5173',
];

/* ── the table ──────────────────────────────────────────────────────── */

// One table, two string keys, no secondary indexes — see store.ts for the
// layout and for why the lookups are items rather than indexes.
//
// Provisioned, not on-demand. That is the single decision that makes this
// deployment free: DynamoDB's free tier is 25 write and 25 read capacity units
// per region per month, perpetually, and it applies to provisioned throughput
// only — on-demand billing cannot touch it. A machine reporting every 30
// seconds costs about 1.2 WCU sustained, so 12 provisioned units carry roughly
// ten machines with burst headroom, and the ceiling before any of this costs
// money is 25.
//
// Going past the provisioned rate throttles rather than bills, and the handler
// answers a throttle with 503 — which makes the agent buffer the reading and
// retry, which is what it already does when the server is away. Raising the
// numbers below is a one-line change; each unit past 25 is about $0.47/month.
const data = backend.createStack('tokenhud-data');
tagStack(data);

const table = new Table(data, 'Table', {
  partitionKey: { name: 'pk', type: AttributeType.STRING },
  sortKey: { name: 'sk', type: AttributeType.STRING },
  billingMode: BillingMode.PROVISIONED,
  writeCapacity: 12,
  readCapacity: 8,
  // Enrollment pointers, stored readings and the cached board all expire
  // themselves. TTL deletes cost nothing, which is the cheapest retention
  // policy there is and the only one with nothing to run.
  timeToLiveAttribute: 'ttl',
  // No point-in-time recovery: it is a continuous backup priced per GB of
  // table size, and this table holds a status board. A machine that loses a
  // week of readings loses nothing anybody was going to look at.
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
  // The stack can be torn down and rebuilt; the machines people enrolled
  // should not evaporate with it.
  removalPolicy: RemovalPolicy.RETAIN,
});

table.grantReadWriteData(backend.api.resources.lambda);
backend.api.addEnvironment('TABLE_NAME', table.tableName);

/* ── what the function needs to know ────────────────────────────────── */

// The portal's routes verify a Cognito ID token against the pool that minted
// it. Passing the ids rather than looking them up keeps the function out of
// the Cognito API on every cold start.
backend.api.addEnvironment('USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
backend.api.addEnvironment(
  'USER_POOL_CLIENT_ID',
  backend.auth.resources.userPoolClient.userPoolClientId,
);
backend.api.addEnvironment('ALLOWED_ORIGINS', origins.join(','));

// A cap on how much a runaway can cost. Ten concurrent executions is roughly
// eighty times the steady-state concurrency of ten machines heartbeating, so
// it never binds in normal use — and it means a loop, a bad deploy or somebody
// hammering the endpoint has a ceiling rather than a bill.
backend.api.resources.cfnResources.cfnFunction.reservedConcurrentExecutions = 10;

/* ── the front door ─────────────────────────────────────────────────── */

// The agent is not a browser and holds no AWS credentials — it authenticates
// with its per-machine key inside the request, so the URL itself is open.
// Every route behind it checks its own credential: an enrollment token, a poll
// secret, a machine key, or a verified Cognito ID token.
//
// Deliberately not IAM auth with CloudFront origin access control. OAC signs
// the request to the function, and Lambda will not accept an unsigned payload,
// so every client posting a body would have to compute a SHA-256 of it and
// send it in x-amz-content-sha256 — including agents already installed, which
// would all break at once. It would buy nothing except protection from someone
// invoking the function URL directly, and reserved concurrency above already
// bounds what that can cost.
const url = backend.api.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

let apiUrl = url.url;

if (wantsDomain) {
  const edge = backend.createStack('tokenhud-edge');
  tagStack(edge);
  const zone = HostedZone.fromHostedZoneAttributes(edge, 'Zone', {
    hostedZoneId: zoneId,
    zoneName,
  });

  const certificate = new Certificate(edge, 'ApiCertificate', {
    domainName: apiDomain,
    validation: CertificateValidation.fromDns(zone),
  });

  const origin = new FunctionUrlOrigin(url);

  // The public board is the same answer for everybody and is already
  // recomputed at most once every five minutes, so letting the edge hold it
  // for sixty seconds turns a burst of readers into one invocation. Nothing
  // is in the cache key — no query strings, no headers, no cookies — because
  // the route takes no arguments: it returns entries, and the page ranks them
  // in the browser. So it is one cached object, not one per reader and not one
  // per metric somebody clicked.
  const boardCache = new CachePolicy(edge, 'BoardCache', {
    defaultTtl: Duration.seconds(60),
    minTtl: Duration.seconds(0),
    maxTtl: Duration.seconds(300),
    queryStringBehavior: CacheQueryStringBehavior.none(),
    headerBehavior: CacheHeaderBehavior.none(),
    cookieBehavior: CacheCookieBehavior.none(),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });

  // Everything else is per-caller and must never be cached. The origin request
  // policy forwards the whole request except Host, which a function URL will
  // not accept rewritten.
  const behavior = {
    origin,
    originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    compress: true,
  };

  const distribution = new Distribution(edge, 'Api', {
    comment: `TokenHUD API — ${apiDomain}`,
    domainNames: [apiDomain],
    certificate,
    // North America and Europe. The cheapest class, and the readings are
    // posted from laptops rather than served to a global audience.
    priceClass: PriceClass.PRICE_CLASS_100,
    // No access logs. CloudFront would write them to S3 by the gigabyte and
    // nothing reads them.
    enableLogging: false,
    defaultBehavior: {
      ...behavior,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
    },
    additionalBehaviors: {
      '/api/v1/leaderboard': {
        ...behavior,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: boardCache,
      },
    },
  });

  const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
  new ARecord(edge, 'ApiA', { zone, recordName: apiDomain, target });
  // AAAA as well as A, because a caller on an IPv6-only network that finds no
  // AAAA record does not fall back — it fails.
  new AaaaRecord(edge, 'ApiAAAA', { zone, recordName: apiDomain, target });

  apiUrl = `https://${apiDomain}`;
}

// Lands in amplify_outputs.json as custom.apiUrl. The portal reads it for
// every call, and builds the `tokenhud-agent enroll "<url>#<token>"` command
// from it — so this one value is what points an agent at the cloud.
backend.addOutput({
  custom: {
    apiUrl,
    // Which board a checkout is looking at. The portal shows it in the
    // self-host panel so nobody has to guess whether they are on a sandbox.
    apiDomain: wantsDomain ? apiDomain : null,
  },
});

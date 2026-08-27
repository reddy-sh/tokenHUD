import { defineFunction } from '@aws-amplify/backend';

// The whole cloud API in one function: the agent's three routes, the portal's
// reads and machine actions, and the public leaderboard.
//
// It is one function rather than several because every route reads the same
// DynamoDB table and the same two credentials, and because Lambda's free tier
// is counted in requests and GB-seconds - splitting the routes across four
// functions would not make any of that smaller, but it would make four cold
// starts, four log groups and four sets of permissions to keep in step.
//
// arm64 is a third cheaper per GB-second than x86 and this workload is JSON
// and gzip, which Graviton is fine at. 256 MB is chosen against measurement,
// not habit: the heaviest request inflates a ~94 KB reading and folds it to a
// rollup, which fits well inside it, and duration scales with memory closely
// enough that a bigger size would cost the same GB-seconds while burning the
// free-tier request budget no faster.
//
// Logs are text at 1-day retention because nobody reads them after a day and
// CloudWatch charges for ingestion. The handler prints on failure only.
export const api = defineFunction({
  name: 'api',
  entry: './handler.ts',
  // The agent gives up on a request after 30 s and buffers the reading, so
  // there is no point holding one longer than that.
  timeoutSeconds: 29,
  memoryMB: 256,
  runtime: 22,
  architecture: 'arm64',
  logging: { format: 'text', retention: '1 day' },
});

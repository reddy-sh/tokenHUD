// Responses, and the cross-origin rules that go on them.
//
// The portal is served from tokenhud.com and the API answers on
// api.tokenhud.com, so every browser call is cross-origin and every one of
// them needs these headers to be right. The agent is not a browser and never
// sends an Origin; nothing here changes what it sees.
//
// The allowed origins are configuration, not a wildcard, because these routes
// carry a bearer token: a page on any origin being able to read the response
// of a request it made with somebody's ID token is the exact thing the
// same-origin policy exists to prevent. The public leaderboard is the one
// exception and says so explicitly — it is published data, read without a
// credential, and it is meant to be embeddable.

import type { LambdaFunctionURLResult } from 'aws-lambda';

const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const BASE = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

export type Cors = { origin?: string; public?: boolean };

function corsHeaders(cors?: Cors): Record<string, string> {
  if (cors?.public) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    };
  }
  const origin = cors?.origin;
  if (!origin || !ALLOWED.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-tokenhud-key',
    'access-control-max-age': '86400',
    // The response body differs by origin only in these headers, but a shared
    // cache that missed that would hand one origin another's answer.
    vary: 'Origin',
  };
}

export function json(statusCode: number, body: unknown, cors?: Cors): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { ...BASE, ...corsHeaders(cors), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const fail = (statusCode: number, error: string, cors?: Cors) =>
  json(statusCode, { error }, cors);

/* A cached answer, for the one route where caching is safe and useful.
 *
 * The public board is the same for everybody and recomputed every five
 * minutes, so letting CloudFront hold it for sixty seconds turns a burst of
 * readers into one invocation. `stale-while-revalidate` means the reader after
 * the minute is up gets the old copy immediately rather than waiting. */
export function cached(body: unknown, seconds: number): LambdaFunctionURLResult {
  return {
    statusCode: 200,
    headers: {
      ...BASE,
      ...corsHeaders({ public: true }),
      'content-type': 'application/json',
      'cache-control': `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`,
    },
    body: JSON.stringify(body),
  };
}

export function preflight(cors?: Cors): LambdaFunctionURLResult {
  return { statusCode: 204, headers: { ...BASE, ...corsHeaders(cors) }, body: '' };
}

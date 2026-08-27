import { defineAuth, secret } from '@aws-amplify/backend';

// Sign-in for the portal: email and password, or Google.
//
// The portal renders its own forms (site/src/components/portal/AuthCard.jsx)
// against the email flows - the Amplify UI kit would drag its own design
// system in. Google cannot work that way: OAuth is a redirect to Google and
// back through Cognito's hosted UI, so that path leaves the site and returns,
// and the callback URLs below are the list of places it is allowed to return
// to. Anything not on this list is refused by Cognito, which is the point.
//
// ── on what this costs ──────────────────────────────────────────────────
//
// Nothing, up to 10,000 monthly active users. Google is a *social* provider in
// Cognito's pricing, so it counts against that allowance rather than against
// the 50-user SAML/OIDC one - which is why this file has a `google` block and
// not an `oidc` block, even though Google speaks OIDC. The user pool stays on
// Amplify's default feature plan: Lite would also be free below 10,000 users,
// and the only thing switching would buy is a deploy that can fail.
//
// ── turning Google on ───────────────────────────────────────────────────
//
// Google is behind TOKENHUD_GOOGLE because it cannot be configured in one
// pass: Google needs the Cognito hosted-UI domain in its redirect URI, and
// that domain does not exist until this backend has been deployed once. So:
//
//   1. deploy without TOKENHUD_GOOGLE
//   2. read auth.oauth.domain out of amplify_outputs.json
//   3. create an OAuth client at console.cloud.google.com with
//      https://<that domain>/oauth2/idpresponse as an authorized redirect URI
//   4. npx ampx sandbox secret set GOOGLE_CLIENT_ID      (or the Amplify
//      npx ampx sandbox secret set GOOGLE_CLIENT_SECRET   console, per branch)
//   5. set TOKENHUD_GOOGLE=1 and deploy again
//
// Without the flag the secrets are never referenced, so a checkout that has
// never seen a Google client still deploys.
const withGoogle = process.env.TOKENHUD_GOOGLE === '1';

// The dashboard lives at platform.tokenhud.com; the marketing site at
// tokenhud.com. Google returns to whichever the user came from - Amplify JS
// matches the current origin against the list below. TOKENHUD_SITE_URL
// overrides the first entry for a branch deploy that lives somewhere else.
const site = (process.env.TOKENHUD_SITE_URL ?? 'https://tokenhud.com').replace(/\/+$/, '');
const returnTo = [
  `${site}/`,
  ...(site === 'https://tokenhud.com' ? ['https://platform.tokenhud.com/'] : []),
  // The portal's dev server is 5174, not Vite's 5173 default: scripts/_lib.sh
  // pins PORTAL_PORT and site/playwright.config.js starts it with
  // --strictPort. Cognito refuses any callback URL not on this list, so 5173
  // here meant a local Google sign-in was bounced at the very last hop, by
  // Cognito, with an error page that says nothing about ports.
  'http://localhost:5174/',
];

export const auth = defineAuth({
  loginWith: withGoogle
    ? {
      email: true,
      externalProviders: {
        google: {
          clientId: secret('GOOGLE_CLIENT_ID'),
          clientSecret: secret('GOOGLE_CLIENT_SECRET'),
          // Only what the board actually shows. A leaderboard that asks for a
          // contacts scope is a leaderboard nobody signs into twice.
          scopes: ['email', 'profile'],
          attributeMapping: { email: 'email' },
        },
        callbackUrls: returnTo,
        logoutUrls: returnTo,
      },
    }
    : { email: true },
});

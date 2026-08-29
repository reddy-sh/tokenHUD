/* The leaderboard, as the browser sees it.
 *
 * The arithmetic moved to shared/ at the repo root when the cloud API stopped
 * being AppSync and started ranking accounts itself: the global board and the
 * private board must agree, and the only way to guarantee that is one copy of
 * the code. Nothing about the browser's imports changed - every component that
 * asked this module for `rankBoard`, `profilesOf`, `METRICS` or a tier still
 * gets it here.
 *
 *   shared/ranking.mjs   tiers, metrics, periods, streaks, rankBoard
 *   shared/profile.mjs   a full reading folded to a rankable entry
 *
 * The API imports the same two files (amplify/functions/api/), which is why
 * the leaderboard you see signed in and the one a stranger sees on the public
 * page are the same ranking rather than two that look alike.
 */

export * from '../../../shared/profile.mjs'
export * from '../../../shared/ranking.mjs'

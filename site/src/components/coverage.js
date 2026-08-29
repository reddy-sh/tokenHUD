/* What TokenHUD can read, in one place, because four places disagreed.
 *
 * This page used to answer "how many agents?" four separate times and give
 * four different answers: nine in the stats band, twenty-six in the
 * integrations heading, "seven more detected" and "TokenHUD's two" in the
 * comparison table, and "Claude Code and Codex CLI today" in the FAQ. On a
 * site whose whole pitch is that its numbers are checkable, a number that
 * contradicts itself two sections later is the most expensive sentence on the
 * page - it invites the reader to distrust the numbers that are right. So
 * every count the marketing page prints is now derived from the lists below,
 * and there is no literal left anywhere to forget to update.
 *
 * The catalogue of record is agent/src/integrations.rs, the file the agent
 * itself resolves against a real machine. What follows is a transcription of
 * it, not a second opinion. Transcribed rather than fetched because this is a
 * static marketing build with no agent on the other end: the alternative is a
 * page that asks a machine which may not exist and prints nothing when it does
 * not, and a coverage claim that disappears is worse than one that is a
 * release behind.
 *
 * The grouping is that file's `Access` enum, kept name for name, because the
 * distinction it draws is the honest one and collapsing it is exactly how this
 * page got into trouble. `Local` means a collector reads this today. `Setup`
 * means a switch on your machine, which you can flip. `Unread` means the
 * numbers are sitting on your disk and we have not written the reader - the
 * gap is ours, not yours, and this page previously filed five such tools under
 * "a step away, local once enabled", which is a claim about TokenHUD dressed
 * up as a claim about the tool. `Api` and `Cloud` are the two kinds of "not on
 * your machine at all".
 *
 * Keeping this in step is manual: adding an entry to CATALOGUE in
 * integrations.rs means adding it here. No test holds the two together,
 * because a Rust test cannot see a JS file and this build never runs the
 * agent. The counts being derived rather than written out is the mitigation -
 * one edit here moves every number on the page at once.
 */

/* Access::Local - a collector opens these files today and reports numbers. */
export const READ = [
  ['Claude Code', 'Sessions, tokens, spend and your plan’s real usage windows - no configuration.'],
  ['Codex CLI', 'Sessions, tokens and rate limits, counted exactly and shown unpriced rather than priced with a made-up rate card.'],
  ['GitHub Copilot CLI', 'Input, output, cache and reasoning tokens per model, plus premium requests and AI units, from the CLI’s own session events.'],
  ['Devin CLI', 'Credits and ACU per session with model and mode, read from the local session store. Conversations are counted, never opened.'],
  ['OpenCode', 'Per-message tokens by model and provider from the local database, plus the cost OpenCode recorded - which on a subscription is no figure at all, and is reported as none rather than as $0.00.'],
]

/* Access::Setup - the numbers exist, or would, once you change one setting. */
export const SETUP = [
  ['Gemini CLI', 'One telemetry block in settings.json and every API call logs its six token counts locally.'],
  ['Aider', 'Local analytics carry per-message tokens and cost by model once switched on. Aider’s own upload stays off.'],
  ['Continue.dev', 'The development-data event log carries tokens per event, with model and provider.'],
  ['Ollama', 'Every response carries its counts and Ollama then discards them. A logging proxy keeps them; the board reports the models running and invents no tokens.'],
]

/* Access::Unread - on your disk, and TokenHUD ships no reader for it. The gap
   is in TokenHUD. Nothing the reader does will close it, so the copy must not
   suggest otherwise. */
export const UNREAD = [
  ['Cline', 'Per-request tokens, cache and cost by default, in the extension’s VS Code storage.'],
  ['Roo Code', 'The Cline layout, forked - one reader would very likely serve both.'],
  ['Kilo Code', 'The Cline layout again, under its own extension id.'],
  ['Goose', 'One JSONL per session with token totals and model, written unprompted.'],
  ['LM Studio', 'Per-message counts and the local model that produced them. Tokens and no dollars: a model on your own hardware has no bill.'],
]

/* Access::Api - usage lives on somebody's server, behind a key most people
   cannot mint. */
export const API = [
  ['Cursor', 'A team admin key reaches per-request tokens. A personal Pro plan has no usage API at all.'],
  ['GitHub Copilot in the IDE', 'Premium requests via the billing API - individually, or org-wide with an owner’s token.'],
  ['Windsurf', 'Credits, not tokens, and only with a team service key.'],
  ['Amazon Q Developer', 'No token metric exists in any of its 43 reports. The board says so instead of implying one.'],
  ['JetBrains AI / Junie', 'Quota used and remaining, held against the JetBrains account.'],
  ['Zed', 'Monthly prompt counts, metered server-side.'],
  ['OpenRouter', 'Not a tool but a router - where the real usage lands for anything pointed at it.'],
  ['Anthropic / OpenAI API', 'The provider’s own admin reports: tokens and cost by day, model and key. The backstop for anything that exposes nothing itself.'],
]

/* Access::Cloud - web products. There is no local trace to read at any
   setting, so the board lists them and claims nothing. */
export const WEB = ['Replit Agent', 'v0', 'Bolt.new', 'Lovable']

/* Every tool in the catalogue, whatever state it is in. */
export const TOOLS_KNOWN = READ.length + SETUP.length + UNREAD.length + API.length + WEB.length

/* The only number that is a claim about what TokenHUD does today. */
export const TOOLS_READ = READ.length

/* Tools whose numbers are on your own disk, whether or not anything here can
   open them yet. The honest denominator for "local-first": it is the size of
   the opportunity, and the gap between it and TOOLS_READ is the backlog. */
export const TOOLS_ON_DISK = READ.length + SETUP.length + UNREAD.length

/* Prose spells its numbers out, and the page should not have to choose between
   reading like a person and being derived from one list. This exists so that
   "Twenty-six tools tracked" can be a computed sentence rather than a literal
   somebody has to remember to retype the day a tool is added - which is the
   failure this whole file is here to prevent. Digits above ninety-nine, where
   spelling stops helping anyone. */
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

export function spell(n) {
  if (n < 20) return ONES[n]
  if (n > 99) return String(n)
  const t = TENS[Math.floor(n / 10)]
  return n % 10 ? `${t}-${ONES[n % 10]}` : t
}

/* The same word at the start of a sentence. */
export const spellCap = n => {
  const w = spell(n)
  return w.charAt(0).toUpperCase() + w.slice(1)
}

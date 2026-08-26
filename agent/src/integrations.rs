//! Every tool TokenHUD knows about, and what to do when it has no data.
//!
//! The board used to show a tool only once it had numbers, which answers the
//! easy question ("what can I see?") and leaves the useful one unanswered
//! ("why can't I see Gemini, and what do I do about it?"). A blank tile is a
//! dead end. So this catalogue lists every tool in the market that burns
//! tokens, states plainly which of four situations it is in on THIS machine,
//! and — this is the part that earns the file — carries the steps that move it
//! to the next one.
//!
//! The four situations, and why they are four rather than two:
//!
//!   · **Reading** — a collector has real numbers, right now.
//!   · **Ready** — the tool is here and TokenHUD can read it; it just has not
//!     recorded anything yet. Nothing to fix; use the tool.
//!   · **Needs setup** — the numbers exist or would exist, but something on
//!     this machine has to be switched on first. Gemini CLI's telemetry is the
//!     archetype: one key in `settings.json` turns an unreadable tool into a
//!     readable one. These tiles carry steps.
//!   · **API only** — the tool keeps nothing local worth reading; its usage
//!     lives behind an admin or billing API, usually one only an org owner can
//!     call. The steps say so, including when the honest answer is "you cannot
//!     do this on a personal plan".
//!
//! A fifth would be dishonest to omit: some tools are pure web products and
//! keep no local trace at all. They are listed as `Cloud` with no steps,
//! because inventing an enablement path for Bolt.new would waste the reader's
//! afternoon.
//!
//! **What is claimed here is scoped deliberately.** `verified` marks the
//! handful of paths confirmed by opening them on a real machine; everything
//! else is `documented` — taken from the tool's own docs or a well-known
//! open-source parser, and not yet seen with our own eyes. The distinction is
//! kept because a setup step that turns out to be wrong costs a user more than
//! a missing tile does, and a catalogue that flattened the two would be
//! claiming a confidence it has not got.
//!
//! Nothing in this file opens a file. It probes for existence — `is_dir`,
//! `exists` — exactly as the assistant detection does, and every path it
//! touches is declared in `manifest.rs` under PROBED.

use crate::transcripts::home;
use serde_json::{json, Value};

/// How this tool's usage can be reached, at best, by a local-first agent.
#[derive(PartialEq, Clone, Copy)]
pub enum Access {
    /// Real token counts sit in local files a collector reads today.
    Local,
    /// Local files carry the numbers, but something must be enabled first.
    Setup,
    /// Nothing usable locally; usage lives behind an API or a dashboard.
    Api,
    /// A web product. No local trace exists to read, at any setting.
    Cloud,
}

impl Access {
    fn as_str(self) -> &'static str {
        match self {
            Access::Local => "local",
            Access::Setup => "setup",
            Access::Api => "api",
            Access::Cloud => "cloud",
        }
    }
}

/// How well this entry is known. See the module comment — the distinction is
/// load-bearing and is surfaced to the board rather than kept as a comment.
#[derive(PartialEq, Clone, Copy)]
pub enum Confidence {
    /// Opened on a real machine and confirmed to hold what this says.
    Verified,
    /// From the tool's documentation or a known parser; not yet seen here.
    Documented,
}

pub struct Integration {
    pub id: &'static str,
    pub name: &'static str,
    /// Rough market position, for ordering a board that cannot show 20 tiles
    /// at once. Adoption ranking, August 2026.
    pub rank: u8,
    pub access: Access,
    pub confidence: Confidence,
    /// Directories or files whose EXISTENCE means the tool is on this machine.
    /// Never opened here.
    pub probes: &'static [&'static str],
    /// Where the numbers are, in one line, in the user's terms.
    pub where_: &'static str,
    /// What can be had: the actual fields, not a vague promise.
    pub fields: &'static str,
    /// What to do when the tile is empty. Empty for tools with nothing to do.
    pub steps: &'static [&'static str],
    pub docs: Option<&'static str>,
}

/// The catalogue, ordered by adoption. Ranks follow the JetBrains 2026 agent
/// survey and the 2025 Stack Overflow developer survey; they order the board
/// and nothing else, so a rank being a year stale costs a tile position rather
/// than a wrong number.
pub const CATALOGUE: &[Integration] = &[
    Integration {
        id: "claude-code",
        name: "Claude Code",
        rank: 1,
        access: Access::Local,
        confidence: Confidence::Verified,
        probes: &[".claude"],
        where_: "~/.claude/projects/**/*.jsonl, one line per message",
        fields: "input, output, cache read and cache write tokens per message, model, \
                 tool and subagent names, plan usage windows, and priced spend",
        steps: &[],
        docs: None,
    },
    Integration {
        id: "codex",
        name: "Codex CLI",
        rank: 2,
        access: Access::Local,
        confidence: Confidence::Verified,
        probes: &[".codex"],
        where_: "~/.codex/sessions/**/*.jsonl, `token_count` events",
        fields: "input, cached input, output and reasoning tokens per session, model, \
                 context window, and the plan's rate-limit windows",
        steps: &[],
        docs: None,
    },
    Integration {
        id: "copilot-cli",
        name: "GitHub Copilot CLI",
        rank: 3,
        access: Access::Local,
        confidence: Confidence::Verified,
        probes: &[".copilot/session-state"],
        where_: "~/.copilot/session-state/<session>/events.jsonl, `session.shutdown` events",
        fields: "input, output, cache read, cache write and reasoning tokens per model, \
                 premium requests, AI units, and tool names",
        steps: &[
            "Install the CLI: npm install -g @github/copilot",
            "Sign in once: run `copilot` and follow the device-code prompt",
            "Use it — a session writes its totals when it exits, and TokenHUD reads them",
        ],
        docs: Some("https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli"),
    },
    Integration {
        id: "devin",
        name: "Devin CLI",
        rank: 14,
        access: Access::Local,
        confidence: Confidence::Verified,
        probes: &[".local/share/devin", ".config/devin"],
        where_: "~/.local/share/devin/cli/sessions.db, the session rows' metadata",
        fields: "credits and ACU per session, model, mode, and timestamps — reported as \
                 credits, never converted to dollars",
        steps: &[
            "Install the CLI: curl -fsSL https://devin.ai/install.sh | sh",
            "Sign in: devin login",
            "Run a session — usage lands in the local SQLite store TokenHUD reads",
        ],
        docs: Some("https://docs.devin.ai/terminal/overview"),
    },
    Integration {
        id: "gemini-cli",
        name: "Gemini CLI",
        rank: 4,
        access: Access::Setup,
        confidence: Confidence::Documented,
        probes: &[".gemini"],
        where_: "the telemetry log the CLI writes once telemetry is enabled, plus session \
                 files under ~/.gemini/tmp/<project>/chats/",
        fields: "input_token_count, output_token_count, cached_content_token_count, \
                 thoughts_token_count, tool_token_count and total_token_count per API call, \
                 from the `gemini_cli.api_response` event",
        steps: &[
            "Open ~/.gemini/settings.json (create it if it is not there)",
            "Add: \"telemetry\": { \"enabled\": true, \"target\": \"local\", \"outfile\": \"~/.gemini/telemetry.log\" }",
            "Use an absolute path for outfile — the documented example is relative to the \
             working directory, which scatters one log per project",
            "Set \"logPrompts\": false in the same block — TokenHUD never wants prompt text, \
             and this stops the CLI writing it to disk in the first place",
            "Run gemini once; the outfile appears and TokenHUD reads it from then on. No \
             collector process is needed: outfile replaces the OTLP endpoint",
        ],
        docs: Some("https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md"),
    },
    Integration {
        id: "cline",
        name: "Cline",
        rank: 8,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".cline"],
        where_: "the extension's VS Code global storage, under saoudrizwan.claude-dev. The \
                 layout inside it has changed between releases, so the collector probes for \
                 the task store rather than assuming a fixed filename",
        fields: "tokensIn, tokensOut, cacheWrites, cacheReads and cost, from the \
                 `api_req_started` records — per request, and summed per task",
        steps: &[
            "Install the Cline extension in VS Code (or the CLI: npm install -g cline)",
            "Run at least one task — tracking is on by default, with nothing to switch on",
            "If you run Cline inside Cursor, VSCodium or VS Code Insiders, its data lives under \
             that editor's own support directory rather than the stock VS Code one",
        ],
        docs: Some("https://docs.cline.bot/"),
    },
    Integration {
        id: "opencode",
        name: "OpenCode",
        rank: 12,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".local/share/opencode"],
        where_: "~/.local/share/opencode/opencode.db on 1.2 and later; per-message JSON \
                 under storage/message/ on older builds",
        fields: "per-message input, output, cache and reasoning tokens, model, and cost",
        steps: &[
            "Install: curl -fsSL https://opencode.ai/install | bash",
            "Run a session — both the current SQLite store and the legacy JSON layout are read",
        ],
        docs: Some("https://opencode.ai/docs/"),
    },
    Integration {
        id: "roo-code",
        name: "Roo Code",
        rank: 11,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".roo"],
        where_: "VS Code global storage under rooveterinaryinc.roo-cline/tasks/",
        fields: "per-task tokens in and out, cache tokens, and cost — the Cline layout, \
                 which Roo forked",
        steps: &[
            "Install the Roo Code extension in VS Code",
            "Run at least one task",
        ],
        docs: Some("https://docs.roocode.com/"),
    },
    Integration {
        id: "kilo-code",
        name: "Kilo Code",
        rank: 17,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".kilocode"],
        where_: "VS Code global storage under kilocode.kilo-code/tasks/",
        fields: "per-task tokens and cost, in the same shape as Cline and Roo",
        steps: &["Install the Kilo Code extension in VS Code", "Run at least one task"],
        docs: Some("https://kilocode.ai/docs"),
    },
    Integration {
        id: "aider",
        name: "Aider",
        rank: 13,
        access: Access::Setup,
        confidence: Confidence::Documented,
        probes: &[".aider.conf.yml", ".aider"],
        where_: "the analytics event file Aider writes when analytics are switched on",
        fields: "per-message prompt and completion tokens and cost, by model",
        steps: &[
            "Turn analytics on for yourself: aider --analytics",
            "Or write it once: put `analytics: true` in ~/.aider.conf.yml",
            "Aider's own analytics upload stays off unless you opt into it separately — \
             this only writes the local file TokenHUD reads",
        ],
        docs: Some("https://aider.chat/docs/more/analytics.html"),
    },
    Integration {
        id: "continue",
        name: "Continue.dev",
        rank: 15,
        access: Access::Setup,
        confidence: Confidence::Documented,
        probes: &[".continue"],
        where_: "~/.continue/dev_data/**/*.jsonl — the development-data event log",
        fields: "tokens generated per event, with model and provider",
        steps: &[
            "Install the Continue extension in VS Code or JetBrains",
            "Development data is written locally by default; check ~/.continue/dev_data exists \
             after a chat",
        ],
        docs: Some("https://docs.continue.dev/customize/deep-dives/development-data"),
    },
    Integration {
        id: "goose",
        name: "Goose",
        rank: 18,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".local/share/goose", ".config/goose"],
        where_: "~/.local/share/goose/sessions/*.jsonl",
        fields: "per-session token totals and model; OpenTelemetry export is available for more",
        steps: &[
            "Install: brew install block-goose-cli",
            "Run a session — Goose writes one JSONL per session",
        ],
        docs: Some("https://block.github.io/goose/"),
    },
    Integration {
        id: "lm-studio",
        name: "LM Studio",
        rank: 19,
        access: Access::Local,
        confidence: Confidence::Documented,
        probes: &[".lmstudio", ".cache/lm-studio"],
        where_: "~/.lmstudio/conversations/*.json",
        fields: "per-message token counts and the local model that produced them — tokens \
                 only, since a local model has no bill",
        steps: &[
            "Install LM Studio and load a model",
            "Chat once, or start its local server — conversations are written to disk",
        ],
        docs: Some("https://lmstudio.ai/docs"),
    },
    Integration {
        id: "ollama",
        name: "Ollama",
        rank: 16,
        access: Access::Setup,
        confidence: Confidence::Documented,
        probes: &[".ollama"],
        where_: "nothing on disk by default — Ollama returns counts per request and keeps none",
        fields: "prompt_eval_count and eval_count per request, if something records them",
        steps: &[
            "Ollama does not persist usage: every response carries the counts and they are \
             then discarded",
            "To capture them, run Ollama behind a logging proxy, or enable OTEL on the client \
             that calls it",
            "TokenHUD reports Ollama as running, and its model list, without inventing token \
             numbers it cannot see",
        ],
        docs: Some("https://github.com/ollama/ollama/blob/main/docs/api.md"),
    },
    Integration {
        id: "cursor",
        name: "Cursor",
        rank: 5,
        access: Access::Api,
        confidence: Confidence::Verified,
        probes: &[".cursor"],
        where_: "nothing readable locally — the chat store keeps timestamps and the tracking \
                 database keeps code attribution, neither holds a token count",
        fields: "via the Teams admin API: inputTokens, outputTokens, cacheWriteTokens, \
                 cacheReadTokens and totalCents per usage event, on the events where \
                 isTokenBasedCall is true",
        steps: &[
            "This needs a Cursor team — a personal Pro plan has no usage API",
            "In the Cursor dashboard, open Settings → Cursor Admin API Keys and create a key",
            "Give it to TokenHUD; it calls POST https://api.cursor.com/teams/\
             filtered-usage-events with that key as the Basic-auth username and no password, \
             dates in epoch milliseconds, up to 60 requests a minute",
            "Note the other endpoints are decoys for this purpose: daily-usage-data and the \
             analytics API return lines, tabs and request counts but no tokens at all",
        ],
        docs: Some("https://cursor.com/docs/account/teams/admin-api"),
    },
    Integration {
        id: "copilot-org",
        name: "GitHub Copilot (IDE)",
        rank: 3,
        access: Access::Api,
        confidence: Confidence::Verified,
        probes: &[".config/github-copilot"],
        where_: "nothing locally — the extension's session store holds the conversation and \
                 no usage. Use the CLI tile for local numbers",
        fields: "via GitHub's APIs: premium-request quantities and dollar amounts per SKU, \
                 and org-level engagement metrics — not raw tokens",
        steps: &[
            "For your own tokens, use the Copilot CLI instead — it writes them locally, and \
             this API reports premium requests rather than tokens either way",
            "As an individual: create a token with Plan read permission and call \
             GET /users/{username}/settings/billing/premium_request/usage — this works on a \
             personal Pro plan, provided the account is on the enhanced billing platform",
            "For an org: an owner enables the Copilot usage-metrics policy, then calls \
             GET /orgs/{org}/copilot/metrics with read:org — engagement only, no tokens",
            "For an enterprise bill: GET /enterprises/{enterprise}/settings/billing/\
             premium_request/usage, which needs an admin or billing manager and a classic \
             token with admin:enterprise",
        ],
        docs: Some("https://docs.github.com/en/rest/billing/usage"),
    },
    Integration {
        id: "windsurf",
        name: "Windsurf",
        rank: 7,
        access: Access::Api,
        confidence: Confidence::Verified,
        probes: &[".codeium", ".windsurf"],
        where_: "nothing readable locally — ~/.codeium holds settings, caches and indexes, \
                 no usage record",
        fields: "via the Cascade Analytics API: day, model, mode, messages sent and \
                 promptsUsed — credits in hundredths, so 100 is one credit. Credits, not tokens: \
                 Windsurf does not expose a token count anywhere",
        steps: &[
            "This needs a Windsurf team — an individual or Pro plan has no usage API, only the \
             plan page in the app and the in-IDE Plan Info tab",
            "A team admin creates a service key with Teams Read-only at windsurf.com/team/manage \
             (Team Settings → Service Keys) and switches on individual-level analytics",
            "POST https://server.codeium.com/api/v1/CascadeAnalytics with that key and read the \
             cascade_runs data source",
            "Until then TokenHUD reports Windsurf as installed and says plainly that it has no \
             numbers, rather than showing an empty chart",
        ],
        docs: Some("https://docs.windsurf.com/plugins/accounts/api-reference/analytics-api-introduction"),
    },
    Integration {
        id: "amazon-q",
        name: "Amazon Q Developer",
        rank: 9,
        access: Access::Api,
        confidence: Confidence::Verified,
        probes: &[".aws/amazonq"],
        where_: "nothing locally — the CLI's chat history holds the conversation and carries \
                 no token or cost field",
        fields: "no tokens, at all. Every one of the 43 metrics Amazon Q reports is a count of \
                 lines, events, messages or findings — this tool cannot fill a token tile from \
                 any source, local or remote",
        steps: &[
            "There is no token metric to fetch: TokenHUD shows Amazon Q as active and says so, \
             rather than implying a number exists that does not",
            "For activity instead of tokens, an admin enables user telemetry and reads the \
             daily per-user CSVs Q writes to S3, or the console dashboards",
            "Open the Amazon Q Developer console → Subscriptions for the same view by hand",
        ],
        docs: Some("https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/monitoring.html"),
    },
    Integration {
        id: "jetbrains-ai",
        name: "JetBrains AI / Junie",
        rank: 6,
        access: Access::Api,
        confidence: Confidence::Documented,
        probes: &[".cache/JetBrains", "Library/Caches/JetBrains"],
        where_: "no local usage file — quota is held against the JetBrains account",
        fields: "quota used and remaining, on the JetBrains account page",
        steps: &[
            "Check your quota at account.jetbrains.com under AI",
            "An organisation can see per-seat usage in the IDE Services console",
            "There is no documented endpoint for a personal licence, so this tile stays \
             informational",
        ],
        docs: Some("https://www.jetbrains.com/help/ai-assistant/"),
    },
    Integration {
        id: "zed",
        name: "Zed",
        rank: 20,
        access: Access::Api,
        confidence: Confidence::Documented,
        probes: &[".config/zed", "Library/Application Support/Zed"],
        where_: "no local usage store — prompt usage is metered server-side",
        fields: "monthly prompt counts on the zed.dev account page",
        steps: &[
            "See usage at zed.dev/account",
            "Using Zed with your own API key instead moves the numbers to that provider, \
             where the provider tile below can reach them",
        ],
        docs: Some("https://zed.dev/docs/ai/plans-and-usage"),
    },
    Integration {
        id: "openrouter",
        name: "OpenRouter",
        rank: 10,
        access: Access::Api,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "not a tool but a router — if a tool here points at OpenRouter, this is where \
                 its real usage lands",
        fields: "per-request tokens, model and cost, by API key, from the activity endpoint",
        steps: &[
            "Create a key at openrouter.ai/keys",
            "Give it to TokenHUD; it calls GET /api/v1/activity for daily usage by model",
            "This catches every tool you have pointed at OpenRouter in one place",
        ],
        docs: Some("https://openrouter.ai/docs/api-reference/overview"),
    },
    Integration {
        id: "provider-api",
        name: "Anthropic / OpenAI API",
        rank: 10,
        access: Access::Api,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "the provider's own admin usage and cost reports — the backstop for any tool \
                 that exposes nothing itself",
        fields: "tokens and cost by day, model, API key and workspace",
        steps: &[
            "Anthropic: create an admin key in the Console (Settings → Admin keys) and read \
             /v1/organizations/usage_report/messages",
            "OpenAI: create an admin key and read /v1/organization/usage/completions",
            "Both are organisation-scoped: they show what the org spent, not which laptop \
             spent it, so they complement the local collectors rather than replacing them",
        ],
        docs: Some("https://docs.claude.com/en/api/admin-api/usage-cost/get-messages-usage-report"),
    },
    Integration {
        id: "replit",
        name: "Replit Agent",
        rank: 16,
        access: Access::Cloud,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "runs in Replit's cloud; nothing touches this machine",
        fields: "checkpoint and effort-based charges, visible in the Replit account only",
        steps: &[],
        docs: None,
    },
    Integration {
        id: "v0",
        name: "v0",
        rank: 11,
        access: Access::Cloud,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "a web product — no local trace at any setting",
        fields: "credits, in the Vercel account",
        steps: &[],
        docs: None,
    },
    Integration {
        id: "bolt",
        name: "Bolt.new",
        rank: 15,
        access: Access::Cloud,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "a web product — no local trace at any setting",
        fields: "tokens, in the StackBlitz account",
        steps: &[],
        docs: None,
    },
    Integration {
        id: "lovable",
        name: "Lovable",
        rank: 17,
        access: Access::Cloud,
        confidence: Confidence::Documented,
        probes: &[],
        where_: "a web product — no local trace at any setting",
        fields: "credits, in the Lovable account",
        steps: &[],
        docs: None,
    },
];

/// Is any of this tool's probe paths on this machine?
///
/// Existence only. A probe is `is_dir`/`exists` and never an open — the same
/// rule the assistant detection follows, and the reason every one of these is
/// declared under PROBED rather than READS.
fn present(probes: &[&str]) -> bool {
    let h = home();
    probes.iter().any(|p| h.join(p).exists())
}

/// The catalogue resolved against this machine.
///
/// `hasData` comes from the collectors that actually ran; passing it in rather
/// than calling them again keeps this to one reading per cycle.
pub fn collect(reading: &[(&str, bool)]) -> Vec<Value> {
    let has_data = |id: &str| {
        reading
            .iter()
            .find(|(k, _)| *k == id)
            .map(|(_, v)| *v)
            .unwrap_or(false)
    };

    CATALOGUE
        .iter()
        .map(|i| {
            let installed = present(i.probes);
            let data = has_data(i.id);
            // The state machine the board renders. "reading" outranks
            // everything: a tool with numbers needs no advice.
            let state = if data {
                "reading"
            } else {
                match i.access {
                    Access::Local if installed => "ready",
                    Access::Local => "absent",
                    Access::Setup if installed => "needs-setup",
                    Access::Setup => "absent",
                    Access::Api => "api-only",
                    Access::Cloud => "cloud-only",
                }
            };
            // What the tile says on its face. Written here rather than in the
            // web app so the CLI, the menu bar app and the board all say the
            // same sentence about the same machine.
            let headline = match state {
                "reading" => "Read by this board.",
                "ready" => "Installed and readable — it has not recorded anything yet.",
                "needs-setup" => "Installed. One step on this machine turns its numbers on.",
                "api-only" if installed => "Installed here, but it keeps no usage on this machine.",
                "api-only" => "Its usage lives behind an API, not on this machine.",
                "cloud-only" => "A web product — nothing to read on this machine.",
                _ => "Not installed here.",
            };
            json!({
                "id": i.id,
                "name": i.name,
                "rank": i.rank,
                "access": i.access.as_str(),
                "confidence": match i.confidence {
                    Confidence::Verified => "verified",
                    Confidence::Documented => "documented",
                },
                "installed": installed,
                "hasData": data,
                "state": state,
                "headline": headline,
                "where": i.where_,
                "fields": i.fields,
                "steps": i.steps,
                "docs": i.docs,
            })
        })
        .collect()
}

/// A one-line count for the board's header, so it does not have to derive the
/// same summary in three places.
pub fn summary(rows: &[Value]) -> Value {
    let count = |state: &str| rows.iter().filter(|r| r["state"] == state).count();
    json!({
        "known": rows.len(),
        "reading": count("reading"),
        "ready": count("ready"),
        "needsSetup": count("needs-setup"),
        "apiOnly": count("api-only"),
        "installed": rows.iter().filter(|r| r["installed"] == true).count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_that_can_be_fixed_says_how() {
        // The point of the file: a tile a user could act on must carry the
        // action. Local tools that are simply not installed are exempt —
        // "install it" is not advice anyone needs written down — but a Setup
        // or Api entry with no steps is a dead end of exactly the kind this
        // catalogue exists to remove.
        for i in CATALOGUE {
            if matches!(i.access, Access::Setup | Access::Api) {
                assert!(
                    !i.steps.is_empty(),
                    "{} is fixable but carries no steps",
                    i.name
                );
            }
            if i.access == Access::Cloud {
                assert!(
                    i.steps.is_empty(),
                    "{} is a web product; steps would be inventing a path that does not exist",
                    i.name
                );
            }
            assert!(!i.where_.is_empty() && !i.fields.is_empty());
        }
    }

    #[test]
    fn a_tool_with_data_is_never_given_advice() {
        // Whatever else is true, a tile that is working must not be telling
        // the user to go and fix it.
        let rows = collect(&[("claude-code", true)]);
        let claude = rows.iter().find(|r| r["id"] == "claude-code").unwrap();
        assert_eq!(claude["state"], "reading");
        assert_eq!(claude["headline"], "Read by this board.");
    }

    #[test]
    fn an_uninstalled_local_tool_is_absent_not_broken() {
        let rows = collect(&[]);
        let row = rows.iter().find(|r| r["id"] == "opencode").unwrap();
        // Whether OpenCode is on the machine running the tests is not knowable
        // here; what must hold is that it is never described as needing setup,
        // because there is nothing to set up until it exists.
        assert!(
            row["state"] == "absent" || row["state"] == "ready",
            "a local tool is either here or not — never mid-configuration"
        );
    }

    #[test]
    fn the_ids_are_unique_and_the_summary_adds_up() {
        let mut ids: Vec<&str> = CATALOGUE.iter().map(|i| i.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate integration id");

        let rows = collect(&[("claude-code", true)]);
        let s = summary(&rows);
        assert_eq!(s["known"], CATALOGUE.len());
        assert!(s["reading"].as_u64().unwrap() >= 1);
    }
}

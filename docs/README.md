# TokenHUD documentation

Everything here is markdown in the repository, readable on GitHub and readable
offline in a checkout. There is no documentation site to keep running, which
means there is no documentation site to fall out of date with the code sitting
next to it.

Pages are grouped the way people arrive at them: getting something working,
then using it, then looking something up, then wanting to know why it is built
the way it is.

## Start here

| | |
|---|---|
| [Install](../INSTALL.md) | Get the agent and the server running, on macOS or Linux |
| [README](../README.md) | What TokenHUD is, what it reads, and what it refuses to read |

## Using the board

| | |
|---|---|
| [The dashboard](dashboard.md) | The two-level navigation, and what lives in each section |
| [The Leaderboard](leaderboard.md) | The four pages, and what every metric on them means |
| [Sharing a board](sharing.md) | Public links: how to publish one, exactly what it carries, how to revoke it |

## Reference

| | |
|---|---|
| [HTTP API](api.md) | Every route, what it requires, and what it answers |
| [Configuration](configuration.md) | Every environment variable, with its default |
| [Server](../server/README.md) | Running the self-host server, and enrolling machines without a UI |
| [Agent](../agent/README.md) | What the agent reads and how it reports |

## How it works

| | |
|---|---|
| [Architecture](ARCHITECTURE.md) | The design record: measurements, the difference format, why Rust |
| [Diagrams](diagrams/) | Eight interactive diagrams of the runtime, the pipelines and the consent flow |
| [Changelog](../CHANGELOG.md) | What changed, and the reasoning behind it |
| [Security](../SECURITY.md) | Reporting a vulnerability, and the threat model |

## Conventions in these pages

**Numbers are labelled with what they are.** Estimated value is at API list
prices and is never a bill; token counts that a collector cannot attribute are
shown as unattributed rather than assigned to something plausible.

**Anything withheld says it is withheld.** A blank on this board means "no
data"; a field that exists but is deliberately not shown says so and says why.

**Examples use `127.0.0.1:8787`**, the default the server binds. Substitute
your own address if you moved it.

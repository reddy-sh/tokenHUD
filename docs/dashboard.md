# The dashboard

The board opens from **Open your board** on the site, or straight from a
checkout with `./scripts/start-portal.sh`. It is a browser talking to a server
you run: no account, no session on anybody else's machine, and the only thing
stored is the server address and the admin key, in this browser's local
storage.

## Two levels of navigation

There are two rails, and they answer different questions.

```text
┌────────────────┬──────────────────┬─────────────────────────────┐
│ ROOT           │ SECTION          │ CONTENT                     │
│                │                  │                             │
│ MONITORING     │ MACHINES         │                             │
│  Token Monit.  │  laptop-a        │                             │
│  Leaderboard   │  laptop-b        │                             │
│ WORKSPACE      │ ASSISTANT        │                             │
│  Settings      │ DASHBOARD        │                             │
│                │  Overview …      │                             │
│ ● Self-hosted  │                  │                             │
│ ‹ Collapse     │ ‹ Collapse       │                             │
└────────────────┴──────────────────┴─────────────────────────────┘
```

The **root rail** — behind the hamburger in the top bar — answers *which
product*. Choosing here changes what the content area **is**.

The **section rail** answers *where inside it*. Token Monitoring's rail picks a
machine and a panel; the Leaderboard's picks one of its four pages; Settings is
a single page and has no second rail at all.

They collapse independently, and that is deliberate: on a narrow screen the
machine list is the first thing worth giving up and the product switch is the
last. Both collapse states persist, as does the section you were last in and
the Leaderboard page you were last on. On a phone the root rail stays as icons
— it is the only way to change section — and the section rail is what drops.

## Token Monitoring

Everything about one machine at a time. The section rail carries:

- **Machines** — every machine reporting, with liveness. Click one to view it;
  rename or remove it in place; **Add machine** hands you the two commands that
  install and enroll an agent, and **Upgrade agents** appears when one is
  behind the latest release.
- **Assistant** — appears when a machine has usage from more than one, so you
  can read the board as Claude Code or as Codex CLI.
- **Dashboard** — the panels, with a live count against each: Overview, Usage
  windows, Recently finished, Activity, Value, Sessions, Models, Running now,
  Projects, MCP servers, Tool calls, Permissions, Extensions, Machines,
  Integrations, Prompts.

Every badge in that list is read from the same array the panel it links to
renders, so a count in the rail cannot drift from the panel it points at.

Before any machine has reported, this section shows the setup wizard instead:
detect the server, verify the key, mint a one-shot enrollment link, and watch
the handshake complete.

## Leaderboard

The fleet rather than a machine — nothing on it is scoped by which laptop is
selected, which is why it is at the root and not behind the machine picker.
Four pages: **Leaderboard**, **Live**, **Models**, **Demand**. See
[The Leaderboard](leaderboard.md).

## Settings

- **Connection** — the server address, whether the admin key is held in this
  browser, and **Disconnect**, which forgets both. The server keeps running.
- **Appearance** — theme, and a switch for each rail.
- **Live updates** — follow or pause the agents, when the last reading landed,
  and how many event-stream readers the server is pushing to against its cap.
- **Public links** — every live share with its view count and its URL, a
  one-click revoke, and **Manage sharing** for the full dialog. See
  [Sharing a board](sharing.md).
- **This server** — machines, snapshots, keyframes, endings, database size and
  path.
- **Agents** — which agent versions are reporting, against the latest release.

## Live updates

The board is pushed to, not polled. The server sends a `reading` event the
moment an agent's snapshot lands, and a slow poll backstops a dropped
connection — so a board left open is current without asking, and a board whose
socket died is stale by seconds rather than silently frozen.

The **Live** switch in the top bar is the manual override. Off, the
subscription is torn down and nothing is fetched; the board holds what it has.

A machine is **up** while its agent has checked in within 2 minutes, **stale**
to 15, **down** after. That is a statement about the agent reporting, not about
whether the machine is switched on.

## What the board stores in your browser

| Key | What it holds |
|---|---|
| `tokenhud_server_url` | The server this board reads |
| `tokenhud_api_key` | The admin key, if one was verified or fetched |
| `tokenhud_theme` | `dark` or `light` |
| `tokenhud_section` | The root section you were last in |
| `tokenhud_lb_page` | The Leaderboard page you were last on |
| `tokenhud_nav_root` | Whether the root rail is collapsed |
| `tokenhud_nav_sub` | Whether the section rail is collapsed |

**Disconnect** in Settings clears the first two. Nothing here is sent anywhere.

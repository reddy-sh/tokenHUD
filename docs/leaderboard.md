# The Leaderboard

Every other panel on the board answers *how much did this machine do*. None of
them answered *compared to what* — and that is the question that changes
behaviour. Nobody opens a ranking to admire the numbers; they open it to find
out where they stand.

The section is four pages because it answers four questions, and one page would
answer all of them badly.

| Page | Question |
|---|---|
| [Leaderboard](#leaderboard-the-standings) | Who is ahead |
| [Live](#live) | What is running at this instant |
| [Models](#models) | Which models did the work, how that is shifting, what it costs |
| [Demand](#demand) | How much, when, and how evenly it is spread |

The same four pages render a [shared board](sharing.md). What a visitor sees
differs from what you see in exactly one thing: the names.

---

## Leaderboard: the standings

A headline, then the ranking.

The **hero** does the arithmetic a table makes you do yourself: the fleet
total, the direction it moved against the week before, how many models are in
use, who is leading, and how much of the total is one machine. That last figure
is there because it changes how every other number should be read.

The **table** ranks one row per machine.

### Rank by

| Metric | What it counts |
|---|---|
| **Tokens** | Every token that moved: input, output, cache reads and cache writes |
| **Est. value** | What the work would have cost at API list prices. Not a bill |
| **Sessions** | Distinct runs, across every assistant that reports them |
| **Tool calls** | Reads, edits, commands — every tool an assistant actually invoked |
| **Active days** | Days with any token on them. The one metric volume cannot buy |

### Over

**Today**, **7 days**, **30 days** or **All time**. A window sums the daily
series; all time trusts the stored total, because the daily series is capped at
90 days and summing it would quietly under-count anyone older than that.

### Reading a row

- **Rank** — a machine with **nothing in the chosen window is unranked, not
  last**. Three machines that did no work today are not tied for third; they
  are simply not on the board yet, and saying so is more useful than a podium
  of zeroes.
- **Tier** — six bands cut on **decades** of tokens, all time: Rookie (0),
  Builder (10M), Operator (100M), Veteran (1B), Master (10B), Legend (100B).
  Decades because that is how this number moves — a heavy week is not twenty
  percent more than a light one, it is ten times, and linear bands would put an
  entire fleet in the same one. The bar under the chip is logarithmic for the
  same reason.
- **Sparkline** — thirty days of the ranked metric, whatever window is being
  ranked. A bar chart of "today" is one bar; the shape is what says whether a
  number is a habit or a spike.
- **Streak** — consecutive days with work on them. Today not having started yet
  does not break one: counting begins at today when today has work and at
  yesterday when it does not. The tooltip carries the longest run.
- **Move** — this window's rank against the previous window of the same length.
  Fifth to second is **▲3**. All time has no previous window, so the column is
  not drawn.
- **you** — the machine Token Monitoring is currently pointed at.

### How evenly the work is spread

Shown once three machines report.

| | |
|---|---|
| **Busiest machine** | Share of all tokens held by the top machine |
| **Top three** | Share held by the top three |
| **Spread** | Gini coefficient: 0 is everybody equal, 1 is one machine and the rest watching |
| **Median machine** | The middle machine's all-time tokens |

A fleet whose top machine is 90% of the tokens is one person's habit wearing a
team's name, and every per-machine average taken off it will be wrong.

---

## Live

What the fleet is running at this instant. A month of tokens says what a fleet
*did*; a count of running agents says what it *is doing*.

- **Agents running**, across how many machines, and how many are headless
- **Reporting** — machines checking in, against the total, and how many have
  gone quiet
- **Blocks open** — five-hour windows in flight, with the requests and output
  tokens inside them
- **Longest running** — the oldest agent currently up
- **By product** and **by kind** — counts per assistant, and per session type
- **Machines with something running** — one row each, with the kinds, the
  longest-running agent, and how far through its five-hour block it is

Two caveats the page states out loud:

**"Right now" is the last reading each machine sent**, so it is up to one
reporting interval old.

**Quiet is not idle.** A machine that stopped reporting shows its last known
state and is marked as such. Conflating the two would understate load exactly
when it mattered.

Every figure here is a count. What any of those agents is working on is not on
the page and is not in the payload the page reads — the whitelist carries the
product, the kind of session, whether it is headless and how long it has been
up, and stops there.

---

## Models

Which models did the work, how that is changing, and what it actually cost.

| Column | Definition |
|---|---|
| **Share** | This model's tokens over all tokens on the board |
| **Tokens** | Input + output + cache reads + cache writes |
| **Output** | Tokens actually written — the useful product |
| **Cache rate** | Cache reads over everything read. High is a long session reusing its context; low is one rebuilding it every turn |
| **Reach** | How many machines used it, over how many are on the board |
| **Est. value** | At API list prices, or *not priced* where this build has no rate card |
| **$/M output** | The whole bill divided by the output tokens it produced, cache reads and writes included |

**Share is depth; reach is breadth**, and they are different findings. A model
one machine leans on is a preference. The same number spread across the fleet
is a standard. A single "tokens" column hides which one you are looking at,
which is why both are here.

**$/M output** is the realised price of a million useful tokens on a real
workload. It is a different number from any rate card and usually a much
smaller one, because a rate card cannot know how much of your context came out
of cache.

### Adoption, day by day

Thirty days of tokens stacked by the model that spent them. A migration looks
like one band giving way to another.

Codex reports a day's tokens without saying which model spent them, so that
share is stacked as **unattributed** rather than folded into a model that did
not earn it. A chart that quietly rounded it away would be the kind of wrong
that only shows up in somebody else's spreadsheet.

### Momentum

The last seven days against the seven before, **in share points**.

Not percentage change: going from 2% to 4% of a fleet is two points, and
calling it "+100%" would be true and useless. Share points say how much of the
fleet moved, which is the question a rank alone cannot answer.

### Export aggregates

Writes a JSON report — schema `tokenhud.fleet-demand/1` — holding totals,
per-model share, reach, cache rates, realised cost, seven-day momentum, ninety
days of daily model split, and the hour-of-day curve.

It carries **no machine identities and no per-machine rows**: a model-demand
report is about models. It is the same data already on the screen, in a shape
something other than a browser can read.

Nothing is uploaded. The file downloads to your machine, and where it goes next
is your decision. See [Sharing a board](sharing.md#what-this-is-for-besides-you).

---

## Demand

The shape of the load — the questions you ask before deciding how much of
something to have ready.

- **Tokens, sessions and estimated value over the last seven days**, each
  against the seven before
- **Tokens per day** and **sessions per day**, thirty days, every machine
  summed
- **When the fleet works** — sessions by hour of day, summed across machines.
  Local time on each machine added together, so a fleet spread across timezones
  flattens this curve rather than showing two peaks
- **Shape of the week** — average tokens per *occurrence* of each weekday over
  eight weeks. Per occurrence, not per weekday total: eight Mondays and five
  Sundays in the window would otherwise make Monday look busier than it is
- **Where the demand comes from** — concentration, and one bar per machine

### The hour curve is withheld below three machines

Summed over a team, "when does this fleet work" is a demand curve. Over one
machine it is a person's sleep schedule, and pseudonymising the row above it
does not change that.

The server does not publish the curve on a shared board with fewer than three
machines, and the page says it is withheld rather than drawing an empty chart.
On your own board — where you own every machine on it — nothing is withheld.

The rule lives in one constant, `HOURS_MIN_MACHINES` in
[`server/src/share.rs`](../server/src/share.rs), and a test holds it in place.

---

## Who this is for, besides you

The same aggregates answer three different questions, which is why they are one
calculation rather than three dashboards.

**Whoever runs the board** wants to know where the spend went, which models are
earning their keep, and whether anything is running that should not be.

**Whoever runs the platform** wants concentration and reach: whether this is
one heavy machine or a habit across the fleet, and whether load is spread or
spiky.

**Whoever builds the models** wants adoption and migration — which model is
taking work from which, how fast, how deep the cache is running, and what a
day's demand curve looks like. That reader is why the export exists, and why it
is aggregate by construction.

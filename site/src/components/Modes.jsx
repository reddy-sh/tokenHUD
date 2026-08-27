/* The act the page was missing.
 *
 * Everything above this section describes a product that runs on localhost and
 * sends nothing: the hero says "Runs on localhost", the stats band counts zero
 * requests, the FAQ says it "sends nothing anywhere". All of that is true of
 * the free tier. Then the primary button opened a hosted board on a domain the
 * page had never mentioned, and a reader who clicked it had every right to feel
 * they had caught the site out.
 *
 * The fix is not to soften the local claims. They are the best thing here and
 * they are exactly true. The fix is that there are two ways to run this and the
 * page only admitted to one, so a strength - you choose, and the boundary holds
 * either way - was arriving as a contradiction. Both columns below are the
 * product. The claim at the bottom is the point of the whole section: enrolling
 * changes where the numbers go, not which numbers exist, because the collectors
 * that never read your prompts are the same collectors either way.
 *
 * It sits directly after Boundary because it is the same argument one step
 * further out: that section draws the line inside the machine, this one draws
 * it at the edge of it. */
export default function Modes() {
  return (
    <section className="wrap section reveal" id="modes">
      <div className="section__head">
        <h2>Two ways to run it. You decide which.</h2>
        <p>Nothing leaves the machine until you enroll it, and enrolling is a command you
          type on a machine you own. Everything on this page above works with the network
          off; everything below is what you get if you want a second machine, or a second
          person, in the same picture.</p>
      </div>

      <div className="boundary">
        <div className="boundary__col">
          <h3>On your machine alone</h3>
          <ul>
            <li>Agent, server and board all on 127.0.0.1</li>
            <li>No account, no key ceremony, no sign-in</li>
            <li>Full history in a SQLite file you own and can delete</li>
            <li>Prices from a rate card compiled into the binary</li>
            <li>Runs with the network off, start to finish</li>
          </ul>
          <p style={{ marginTop: 'var(--space-md)', color: 'var(--color-ink-2)', fontSize: 'var(--text-sm)' }}>
            <strong style={{ color: 'var(--color-ink)' }}>What leaves: nothing.</strong> Not a
            pricing lookup, not a version check, not an error report.
          </p>
        </div>

        <div className="boundary__col">
          <h3>Connected to the hosted board</h3>
          <ul>
            <li>One enroll command per machine, which shows the read manifest and asks first</li>
            <li>Every machine you own on one board, wherever you are</li>
            <li>History that survives a laptop being reinstalled</li>
            <li>A public leaderboard you have to switch on separately, and can switch off</li>
            <li>Readings arrive every thirty seconds; the board pulls every twenty</li>
          </ul>
          <p style={{ marginTop: 'var(--space-md)', color: 'var(--color-ink-2)', fontSize: 'var(--text-sm)' }}>
            <strong style={{ color: 'var(--color-ink)' }}>What leaves: metrics.</strong> Token
            counts, model names, timings, session and tool-call counts, and the computed
            estimate. Never prompts, completions, source, tool arguments, file paths or
            project names - those are not collected in the first place, so there is nothing
            to transmit.
          </p>
        </div>
      </div>

      <div className="boundary__claim">
        <p>The boundary does not move when you enroll. The same collectors run and the same
          fields are never read - enrolling changes where the numbers go, not which numbers
          exist. That is why the second column can be specific about what it sends: the list
          is short because the reading is short.</p>
      </div>
    </section>
  )
}

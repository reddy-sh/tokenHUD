import { TOOLS_KNOWN, TOOLS_READ } from './coverage'

export default function Stats() {
  /* Two of these four were wrong in the same way, which is worth saying out
     loud because the fix is not "be vaguer".

     The agent count was a literal - nine - that matched nothing in the agent's
     own catalogue and contradicted three other sections of this page. It is
     derived now; see coverage.js.

     "0 requests leaving your machine" was true of the product this page
     described and false of the button at the bottom of it, which sends people
     to a hosted board. Zero is still the right number and it is still the
     interesting one: what it needs is the clause that says how long it holds.
     Dropping the zero to avoid the awkwardness would have thrown away the
     strongest fact on the page to hide a sentence that was merely incomplete. */
  const items = [
    { value: '~4 MB', label: 'Two static binaries - nothing else to install' },
    { value: '0.06 s', label: 'Per reading - you will not feel it running' },
    { value: '0', label: 'Requests leaving your machine until you connect it to the cloud board' },
    { value: String(TOOLS_READ), label: `AI agents read straight off the disk, of ${TOOLS_KNOWN} tracked` },
  ]

  return (
    <section className="wrap section" aria-label="Key numbers">
      <div className="stats tnum">
        {items.map((s, i) => (
          <div key={i}>
            <div className="stat__value">{s.value}</div>
            <div className="stat__label">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

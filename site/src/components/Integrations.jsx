import { API, READ, SETUP, spell, spellCap, TOOLS_KNOWN, TOOLS_ON_DISK, TOOLS_READ, UNREAD, WEB } from './coverage'

/* The lists used to live in this file, which is how the page came to disagree
   with itself: the heading counted one set of tools and the stats band, the
   comparison table and the FAQ each counted another. They live in coverage.js
   now, transcribed from the agent's own catalogue, and this file only draws
   them. Every number below is `.length`.

   The four groups are the honest shape of this market, and the fourth is the
   one that costs something to admit: a few tools write real token counts to
   disk, a few would with one setting changed, several write them and TokenHUD
   has not yet written the reader, and the rest keep the numbers on their own
   servers or never touch your machine at all. This page used to fold that
   fourth group in with the second under "one step away", which told five sets
   of users to go looking for a setting that does not exist. */

export default function Integrations() {
  return (
    <section className="wrap section reveal" id="integrations">
      <div className="section__head">
        <h2>{spellCap(TOOLS_KNOWN)} tools tracked. {spellCap(TOOLS_READ)} read straight off the disk.</h2>
        <p>
          Detected, readable and read are three different facts, and the board refuses to
          conflate them. Every tool it knows about gets a tile - and a tile with no numbers
          tells you what would give it some, including when the honest answer is that the
          missing piece is ours.
        </p>
      </div>

      <div className="int-grid">
        {READ.map(([name, note]) => (
          <div className="int-card" key={name}>
            <h3>{name} <span className="tag tag--read">read by the board</span></h3>
            <p>{note}</p>
          </div>
        ))}
      </div>

      <div className="int-card" style={{ marginBottom: 'var(--space-lg)' }}>
        <h3>A step away <span className="tag tag--soon">local, once enabled</span></h3>
        <ul className="detected-list">
          {SETUP.map(([name, note]) => <li key={name}><b>{name}</b> - {note}</li>)}
        </ul>
      </div>

      {/* The group that names our own backlog. It is on the page because a
          reader running Cline deserves to know why their tile is empty, and
          "nothing on your machine is switched off" is a more useful sentence
          than an unexplained blank - even though it is an admission. */}
      <div className="int-card" style={{ marginBottom: 'var(--space-lg)' }}>
        <h3>On your disk, unread <span className="tag tag--soon">no collector yet</span></h3>
        <ul className="detected-list">
          {UNREAD.map(([name, note]) => <li key={name}><b>{name}</b> - {note}</li>)}
        </ul>
        <p style={{ marginTop: 'var(--space-md)' }}>
          Nothing on your machine is switched off for these. They record tokens by default
          and TokenHUD has not written the reader - the gap is in TokenHUD, and no setting
          of yours will close it.
        </p>
      </div>

      <div className="int-card">
        <h3>Usage lives on their servers <span className="tag tag--soon">needs a key</span></h3>
        <ul className="detected-list">
          {API.map(([name, note]) => <li key={name}><b>{name}</b> - {note}</li>)}
        </ul>
        <p style={{ marginTop: 'var(--space-md)' }}>
          {WEB.slice(0, -1).join(', ')} and {WEB[WEB.length - 1]} are web products and leave no
          local trace, so the board lists them and claims nothing. That leaves {spell(TOOLS_ON_DISK)}{' '}
          tools whose numbers sit on your own machine, {spell(TOOLS_READ)} of which are read
          today. Want yours read properly?{' '}
          <a href="https://github.com/reddy-sh/tokenhud/issues" style={{ color: 'var(--color-accent)' }}>
            Open an issue.
          </a>
        </p>
      </div>
    </section>
  )
}

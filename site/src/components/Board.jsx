export default function Board() {
  return (
    <section className="wrap section reveal" id="board">
      <div className="section__head">
        <h2>A board you leave open.</h2>
        <p>Open it in the morning, glance at it all day. Every question you would
          have to type is a number already on screen — pushed over SSE the instant
          a reading lands.</p>
      </div>

      <figure className="board-preview">
        <img
          src="/board.png"
          alt="The TokenHUD board: plan usage windows with reset countdowns, recently finished agents, daily activity and tokens by model"
          width={1440}
          height={900}
          loading="lazy"
        />
        <figcaption>Synthetic data — the project names and figures are generated, not a real machine's.</figcaption>
      </figure>

      <div className="legend">
        <div>
          <h3>Your plan's real limits</h3>
          <p>The five-hour and seven-day windows, with live countdowns to each reset.
            Stale data says it is stale.</p>
        </div>
        <div>
          <h3>What finished while you were away</h3>
          <p>Sit back down and see what ended — with an honest time range, never a
            precise time on a guess.</p>
        </div>
        <div>
          <h3>Spend by session, model and day</h3>
          <p>Priced at API list rates and labelled an estimate everywhere a dollar
            appears — a yardstick, not a bill.</p>
        </div>
      </div>
    </section>
  )
}

export default function Boundary() {
  return (
    <section className="wrap section reveal" id="boundary">
      <div className="section__head">
        <h2>Metrics leave. Content never does.</h2>
        <p>The right-hand column is not filtered out before sending. It is never read into the
          payload in the first place — there is no code path that collects it.</p>
      </div>

      <div className="boundary">
        <div className="boundary__col">
          <h3>Read and reported</h3>
          <ul>
            <li>Token counts — in, out, cached</li>
            <li>Model identifiers</li>
            <li>Computed cost, labelled an estimate</li>
            <li>Session start, stop, duration</li>
            <li>Agent runtime and version</li>
            <li>MCP server names and health</li>
          </ul>
        </div>
        <div className="boundary__col boundary__col--never">
          <h3>Never collected at all</h3>
          <ul>
            <li>Prompt text</li>
            <li>Completion text</li>
            <li>Source code, file contents</li>
            <li>Tool-call arguments and results</li>
            <li>Environment variables, secrets</li>
          </ul>
        </div>
      </div>

      <div className="boundary__claim">
        <p>We can tell your finance team exactly what you spent. We cannot tell them what you wrote.</p>
      </div>
    </section>
  )
}

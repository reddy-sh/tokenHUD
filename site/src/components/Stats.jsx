export default function Stats() {
  const items = [
    { value: '~4 MB', label: 'Two static binaries — nothing else to install' },
    { value: '0.06 s', label: 'Per reading — you will not feel it running' },
    { value: '0', label: 'Requests leaving your machine' },
    { value: '9', label: 'AI agents detected and tracked' },
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

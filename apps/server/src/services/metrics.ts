/** Minimal Prometheus text exposition without extra dependencies. */
export class Metrics {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histos = new Map<
    string,
    Map<string, { sum: number; count: number; buckets: Map<number, number> }>
  >();
  private readonly BUCKETS = [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 180_000];

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const m = this.counters.get(name) ?? new Map<string, number>();
    const k = labelKey(labels);
    m.set(k, (m.get(k) ?? 0) + by);
    this.counters.set(name, m);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const m = this.gauges.get(name) ?? new Map<string, number>();
    m.set(labelKey(labels), value);
    this.gauges.set(name, m);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const m = this.histos.get(name) ?? new Map();
    const k = labelKey(labels);
    const h = m.get(k) ?? { sum: 0, count: 0, buckets: new Map<number, number>() };
    h.sum += value;
    h.count += 1;
    for (const b of this.BUCKETS) if (value <= b) h.buckets.set(b, (h.buckets.get(b) ?? 0) + 1);
    m.set(k, h);
    this.histos.set(name, m);
  }

  render(extraGauges: Record<string, number> = {}): string {
    const lines: string[] = [];
    for (const [name, m] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [k, v] of m) lines.push(`${name}${k} ${v}`);
    }
    for (const [name, m] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [k, v] of m) lines.push(`${name}${k} ${v}`);
    }
    for (const [name, v] of Object.entries(extraGauges)) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    }
    for (const [name, m] of this.histos) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [k, h] of m) {
        const inner = k.slice(1, -1);
        let cum = 0;
        for (const b of this.BUCKETS) {
          cum = h.buckets.get(b) ?? cum;
          lines.push(`${name}_bucket{${inner ? inner + ',' : ''}le="${b}"} ${cum}`);
        }
        lines.push(`${name}_bucket{${inner ? inner + ',' : ''}le="+Inf"} ${h.count}`);
        lines.push(`${name}_sum${k} ${h.sum}`, `${name}_count${k} ${h.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',')}}`;
}

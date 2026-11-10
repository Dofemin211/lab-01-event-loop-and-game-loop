export type PerformanceStage = 'simulate' | 'render' | 'decode' | 'reconcile';

const MAX_SAMPLES = 600;
const samples = new Map<PerformanceStage, number[]>();

export function measureStage<Result>(stage: PerformanceStage, operation: () => Result): Result {
  const startMark = `dogfight:${stage}:start`;
  const endMark = `dogfight:${stage}:end`;
  const measureName = `dogfight.${stage}`;
  performance.mark(startMark);
  try {
    return operation();
  } finally {
    performance.mark(endMark);
    const measure = performance.measure(measureName, startMark, endMark);
    const stageSamples = samples.get(stage) ?? [];
    stageSamples.push(measure.duration);
    if (stageSamples.length > MAX_SAMPLES) stageSamples.shift();
    samples.set(stage, stageSamples);
    performance.clearMarks(startMark);
    performance.clearMarks(endMark);
    if (performance.getEntriesByName(measureName, 'measure').length >= MAX_SAMPLES) {
      performance.clearMeasures(measureName);
    }
  }
}

export function performanceStagePercentiles(): Readonly<
  Record<PerformanceStage, { readonly p50: number; readonly p95: number; readonly p99: number }>
> {
  const percentile = (stage: PerformanceStage, fraction: number): number => {
    const sorted = [...(samples.get(stage) ?? [])].sort((a, b) => a - b);
    return sorted.length ? (sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) : 0;
  };
  return {
    simulate: {
      p50: percentile('simulate', 0.5),
      p95: percentile('simulate', 0.95),
      p99: percentile('simulate', 0.99),
    },
    render: {
      p50: percentile('render', 0.5),
      p95: percentile('render', 0.95),
      p99: percentile('render', 0.99),
    },
    decode: {
      p50: percentile('decode', 0.5),
      p95: percentile('decode', 0.95),
      p99: percentile('decode', 0.99),
    },
    reconcile: {
      p50: percentile('reconcile', 0.5),
      p95: percentile('reconcile', 0.95),
      p99: percentile('reconcile', 0.99),
    },
  };
}

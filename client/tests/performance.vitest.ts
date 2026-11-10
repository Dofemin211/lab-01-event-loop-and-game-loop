import { expect, test } from 'vitest';
import { measureStage, performanceStagePercentiles } from '../src/performance.ts';

test('performance: stage measurements expose bounded percentile data', () => {
  const result = measureStage('simulate', () => 42);
  const percentiles = performanceStagePercentiles().simulate;
  expect(result).toBe(42);
  expect(percentiles.p50).toBeGreaterThanOrEqual(0);
  expect(percentiles.p95).toBeGreaterThanOrEqual(percentiles.p50);
  expect(percentiles.p99).toBeGreaterThanOrEqual(percentiles.p95);
  expect(performance.getEntriesByName('dogfight.simulate', 'measure').length).toBeGreaterThan(0);
});

#!/usr/bin/env node
/**
 * Phase 2 benchmark: compares warm `nx show projects` wall-clock with V8
 * compile cache enabled vs disabled. Each run wipes the cache dir to start
 * cold, then measures a series of warm runs with the cache populating after
 * the first.
 *
 * Run: node --loader ts-node/esm scripts/benchmarks/compile-cache.ts
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const REPO = process.cwd();
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

function clearPluginCache() {
  try {
    rmSync(join(REPO, '.nx/workspace-data/v8-cache'), {
      recursive: true,
      force: true,
    });
  } catch {}
}

function run(env: Record<string, string>, label: string): number {
  const start = performance.now();
  const res = spawnSync('npx', ['nx', 'show', 'projects', '--json'], {
    env: { ...process.env, NX_DAEMON: 'false', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed: status ${res.status}`);
  }
  return performance.now() - start;
}

function summarize(values: number[]): { median: number; mean: number } {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    mean: values.reduce((s, v) => s + v, 0) / values.length,
  };
}

async function main() {
  const results: Record<string, number[]> = {};

  // Warm cache scenario: seed once, then measure.
  clearPluginCache();
  run({}, 'cache-seeding run');
  for (let i = 0; i < RUNS; i++) {
    (results['with-cache'] ??= []).push(run({}, `with-cache ${i}`));
  }

  // No-cache scenario: wipe before each run AND disable via env.
  for (let i = 0; i < RUNS; i++) {
    clearPluginCache();
    (results['no-cache'] ??= []).push(
      run({ NX_PLUGIN_COMPILE_CACHE: 'false' }, `no-cache ${i}`)
    );
  }

  console.log('\n=== Results ===');
  for (const [key, values] of Object.entries(results)) {
    const { median, mean } = summarize(values);
    console.log(
      `${key.padEnd(12)} median=${median.toFixed(0).padStart(5)}ms mean=${mean
        .toFixed(0)
        .padStart(5)}ms runs=${values.length}`
    );
  }
}

void main();

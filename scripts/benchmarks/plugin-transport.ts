#!/usr/bin/env node
/**
 * Phase 1 benchmark: compares cold + warm `nx show projects` wall-clock
 * under both plugin worker transports (subprocess vs worker_threads).
 *
 * Run: node --loader ts-node/esm scripts/benchmarks/plugin-transport.ts
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const REPO = process.cwd();
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const MODES: Array<'process' | 'threads'> = ['process', 'threads'];

function clearCache() {
  try {
    rmSync(join(REPO, '.nx/cache'), { recursive: true, force: true });
  } catch {}
  try {
    rmSync(join(REPO, '.nx/workspace-data'), { recursive: true, force: true });
  } catch {}
}

function run(mode: 'process' | 'threads', label: string): number {
  const start = performance.now();
  const res = spawnSync('npx', ['nx', 'show', 'projects', '--json'], {
    env: {
      ...process.env,
      NX_PLUGIN_WORKER_TRANSPORT: mode,
      NX_DAEMON: 'false',
    },
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
  for (const mode of MODES) {
    for (let i = 0; i < RUNS; i++) {
      clearCache();
      (results[`${mode}-cold`] ??= []).push(run(mode, `${mode} cold ${i}`));
      (results[`${mode}-warm`] ??= []).push(run(mode, `${mode} warm ${i}`));
    }
  }
  console.log('\n=== Results ===');
  for (const [key, values] of Object.entries(results)) {
    const { median, mean } = summarize(values);
    console.log(
      `${key.padEnd(20)} median=${median.toFixed(0).padStart(5)}ms mean=${mean
        .toFixed(0)
        .padStart(5)}ms runs=${values.length}`
    );
  }
}

void main();

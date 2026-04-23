#!/usr/bin/env node
/**
 * Phase 1 × Phase 2 matrix benchmark.
 *
 * Loads every plugin this repo's nx.json configures (plus the defaults that
 * get-plugins.ts adds implicitly), via IsolatedPlugin.load, under all four
 * combinations of (transport, compile-cache).
 *
 * Run from repo root:
 *   node --loader ts-node/esm scripts/benchmarks/phase1-phase2-matrix.ts
 * or (faster, already compiled elsewhere):
 *   npx tsx scripts/benchmarks/phase1-phase2-matrix.ts
 *
 * Output: four lines reporting median/mean/min of plugin-load wall time per combo.
 */
import { performance } from 'node:perf_hooks';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'packages/nx/dist');
const V8_CACHE = join(ROOT, '.nx/workspace-data/v8-cache');

process.env.NX_WORKSPACE_ROOT_PATH = ROOT;

type Combo = {
  transport: 'process' | 'threads';
  cache: 'on' | 'off';
};

const COMBOS: readonly Combo[] = [
  { transport: 'process', cache: 'off' },
  { transport: 'process', cache: 'on' },
  { transport: 'threads', cache: 'off' },
  { transport: 'threads', cache: 'on' },
] as const;

function key(c: Combo): string {
  return `${c.transport}+cache-${c.cache}`;
}

function wipeCache(): void {
  try {
    rmSync(V8_CACHE, { recursive: true, force: true });
  } catch {}
}

/**
 * Mimics get-plugins.ts:getDefaultPlugins + loadSpecifiedNxPlugins, but loads
 * through IsolatedPlugin.load directly. Bypasses the daemon, arg parsing,
 * project-graph aggregation — so the measurement is plugin-load-only.
 */
async function loadAllPlugins(
  IsolatedPlugin: any,
  readNxJson: any,
  shouldMergeAngularProjects: any,
  targetCount: number | null
): Promise<number> {
  const pluginsConfig = readNxJson(ROOT).plugins ?? [];

  const defaultPlugins: string[] = [
    join(DIST, 'src/plugins/js'),
    ...(shouldMergeAngularProjects(ROOT, false)
      ? [join(DIST, 'src/adapter/angular-json')]
      : []),
    join(DIST, 'src/plugins/package-json'),
    join(DIST, 'src/plugins/project-json/build-nodes/project-json'),
  ];

  // Build the real combined list (defaults + nx.json specified) then, if a
  // targetCount is requested, pad it by cycling through the same list. Each
  // IsolatedPlugin.load call spawns its own worker regardless of duplicates,
  // so this scales worker count without needing more fixture plugins.
  const combined: Array<{ plugin: any; isDefault: boolean }> = [
    ...defaultPlugins.map((p) => ({ plugin: p, isDefault: true })),
    ...pluginsConfig.map((p: any) => ({ plugin: p, isDefault: false })),
  ];
  let toLoad = combined;
  if (targetCount && combined.length < targetCount) {
    toLoad = [];
    for (let i = 0; i < targetCount; i++) {
      toLoad.push(combined[i % combined.length]);
    }
  }

  const start = performance.now();
  const instances = await Promise.all(
    toLoad.map((entry, i) =>
      IsolatedPlugin.load(entry.plugin, ROOT, entry.isDefault ? undefined : i)
    )
  );
  const elapsed = performance.now() - start;

  for (const inst of instances) inst.shutdown();
  return elapsed;
}

function requireFresh(modPath: string): any {
  // Drop anything under packages/nx/dist so env-var-dependent modules
  // (transport-flag, compile-cache) re-read on first use within each iter.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/packages/nx/dist/')) delete require.cache[k];
  }
  return require(modPath);
}

async function measure(
  combo: Combo,
  targetCount: number | null
): Promise<number> {
  process.env.NX_PLUGIN_WORKER_TRANSPORT = combo.transport;
  if (combo.cache === 'off') {
    process.env.NX_PLUGIN_COMPILE_CACHE = 'false';
    // Do NOT wipe the cache dir here. With cache disabled the on-disk cache
    // is irrelevant — wiping it would invalidate the cache-on combos'
    // warm state on the next iteration and make "cache-on" effectively
    // "cache-on-after-wipe" which hides the Phase 2 win.
  } else {
    delete process.env.NX_PLUGIN_COMPILE_CACHE;
  }

  const { IsolatedPlugin } = requireFresh(
    join(DIST, 'src/project-graph/plugins/isolation/isolated-plugin.js')
  );
  const { readNxJson } = require(join(DIST, 'src/config/nx-json.js'));
  const { shouldMergeAngularProjects } = require(
    join(DIST, 'src/adapter/angular-json.js')
  );

  return loadAllPlugins(
    IsolatedPlugin,
    readNxJson,
    shouldMergeAngularProjects,
    targetCount
  );
}

function summarize(values: number[]): {
  median: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
} {
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / values.length;
  return {
    median,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: Math.sqrt(variance),
  };
}

async function main() {
  const N = Number(process.env.BENCH_RUNS ?? 5);
  const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
  const PLUGIN_COUNT_RAW = process.env.BENCH_PLUGIN_COUNT;
  const TARGET_COUNT: number | null = PLUGIN_COUNT_RAW
    ? Number(PLUGIN_COUNT_RAW)
    : null;

  console.log(`Benchmark: ${N} measured runs per combo, ${WARMUP} warmup each`);
  console.log(`Workspace: ${ROOT}`);
  if (TARGET_COUNT) {
    console.log(`Padding plugin list to ${TARGET_COUNT} workers per run`);
  }
  console.log('');

  // Warmup — also populates the V8 cache for cache-on combos
  for (const combo of COMBOS) {
    for (let i = 0; i < WARMUP; i++) {
      await measure(combo, TARGET_COUNT);
    }
  }

  const results = new Map<string, number[]>();
  // Interleave combos across iterations to neutralize time-of-day drift.
  for (let i = 0; i < N; i++) {
    for (const combo of COMBOS) {
      const t = await measure(combo, TARGET_COUNT);
      const k = key(combo);
      if (!results.has(k)) results.set(k, []);
      results.get(k)!.push(t);
    }
  }

  console.log('Results:\n');
  console.log(
    'combo'.padEnd(24) +
      'median'.padStart(10) +
      'mean'.padStart(10) +
      'min'.padStart(10) +
      'max'.padStart(10) +
      'stddev'.padStart(10)
  );
  console.log('-'.repeat(74));

  // Baseline = process + cache-off, for computing deltas.
  const baseline = results.get('process+cache-off');
  const baselineMean = baseline ? summarize(baseline).mean : NaN;

  for (const combo of COMBOS) {
    const k = key(combo);
    const values = results.get(k)!;
    const s = summarize(values);
    const delta = isFinite(baselineMean)
      ? `  (${((s.mean - baselineMean) / baselineMean) * 100 >= 0 ? '+' : ''}${(
          ((s.mean - baselineMean) / baselineMean) *
          100
        ).toFixed(1)}% vs baseline mean)`
      : '';
    console.log(
      k.padEnd(24) +
        `${s.median.toFixed(0)}ms`.padStart(10) +
        `${s.mean.toFixed(0)}ms`.padStart(10) +
        `${s.min.toFixed(0)}ms`.padStart(10) +
        `${s.max.toFixed(0)}ms`.padStart(10) +
        `${s.stddev.toFixed(0)}ms`.padStart(10) +
        delta
    );
  }
  console.log('\nRaw (per-iteration, in measurement order):');
  for (const combo of COMBOS) {
    const k = key(combo);
    const values = results.get(k)!;
    console.log(
      `  ${k.padEnd(24)} ${values.map((v) => v.toFixed(0)).join(' ')}`
    );
  }
  console.log('');
  console.log(`Baseline (for deltas): process+cache-off`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

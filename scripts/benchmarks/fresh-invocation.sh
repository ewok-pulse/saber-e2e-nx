#!/usr/bin/env bash
# Fresh-process benchmark: each measurement is a brand-new tsx process,
# mimicking how real `nx` invocations work (every CLI invocation is cold).
# The compile cache persists across runs (disk-based).
set -euo pipefail

REPO="${BENCH_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
RUNS="${BENCH_RUNS:-15}"
COUNT="${BENCH_PLUGIN_COUNT:-50}"
TSX="$REPO/node_modules/.bin/tsx"

cat > /tmp/fresh-one-shot.ts <<'EOT'
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
const ROOT = process.env.NX_WORKSPACE_ROOT_PATH!;
const DIST = join(ROOT, 'packages/nx/dist');

const { IsolatedPlugin } = require(join(DIST, 'src/project-graph/plugins/isolation/isolated-plugin.js'));
const { readNxJson } = require(join(DIST, 'src/config/nx-json.js'));
const { shouldMergeAngularProjects } = require(join(DIST, 'src/adapter/angular-json.js'));

(async () => {
  const count = Number(process.argv[2] || 50);
  const pluginsConfig = readNxJson(ROOT).plugins ?? [];
  const defaults = [
    join(DIST, 'src/plugins/js'),
    ...(shouldMergeAngularProjects(ROOT, false) ? [join(DIST, 'src/adapter/angular-json')] : []),
    join(DIST, 'src/plugins/package-json'),
    join(DIST, 'src/plugins/project-json/build-nodes/project-json'),
  ];
  const combined = [...defaults.map(p => ({plugin: p, isDefault: true})), ...pluginsConfig.map((p:any) => ({plugin: p, isDefault: false}))];
  const toLoad = [];
  for (let i = 0; i < count; i++) toLoad.push(combined[i % combined.length]);

  const t = performance.now();
  const insts = await Promise.all(toLoad.map((e, i) =>
    IsolatedPlugin.load(e.plugin, ROOT, e.isDefault ? undefined : i)));
  const elapsed = performance.now() - t;
  for (const i of insts) i.shutdown();
  process.stdout.write(elapsed.toFixed(1));
})();
EOT

# Seed: warm the compile cache once per mode
export NX_WORKSPACE_ROOT_PATH="$REPO"
echo "Seeding cache..."
NX_PLUGIN_WORKER_TRANSPORT=process "$TSX" /tmp/fresh-one-shot.ts "$COUNT" >/dev/null
NX_PLUGIN_WORKER_TRANSPORT=threads "$TSX" /tmp/fresh-one-shot.ts "$COUNT" >/dev/null

echo "Measuring $RUNS runs per combo, $COUNT plugins, fresh process each..."
echo "run,mode,cache,ms"
for i in $(seq 1 "$RUNS"); do
  # Interleave the 4 combos; order randomized by pair even/odd
  if (( i % 2 == 0 )); then
    order=("process-off" "threads-off" "process-on" "threads-on")
  else
    order=("threads-on" "process-on" "threads-off" "process-off")
  fi
  for combo in "${order[@]}"; do
    mode="${combo%-*}"
    cache="${combo##*-}"
    if [[ "$cache" == "off" ]]; then
      ms=$(NX_PLUGIN_WORKER_TRANSPORT=$mode NX_PLUGIN_COMPILE_CACHE=false "$TSX" /tmp/fresh-one-shot.ts "$COUNT" 2>/dev/null)
    else
      ms=$(NX_PLUGIN_WORKER_TRANSPORT=$mode "$TSX" /tmp/fresh-one-shot.ts "$COUNT" 2>/dev/null)
    fi
    echo "$i,$mode,$cache,$ms"
  done
done

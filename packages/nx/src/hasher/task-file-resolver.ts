import { minimatch } from 'minimatch';
import type { NxJsonConfiguration } from '../config/nx-json';
import type { ProjectGraph } from '../config/project-graph';
import { getOutputsForTargetAndConfiguration } from '../tasks-runner/utils';
import { splitByColons } from '../utils/split-target';
import { workspaceRoot as defaultWorkspaceRoot } from '../utils/workspace-root';
import { HashPlanInspector } from './hash-plan-inspector';

export interface TaskFileResolver {
  getInputs(taskId: string): string[];
  getOutputs(taskId: string): string[];
  isInput(taskId: string, path: string): boolean;
  isOutput(taskId: string, path: string): boolean;
}

export async function createTaskFileResolver(options: {
  projectGraph: ProjectGraph;
  nxJson?: NxJsonConfiguration;
  workspaceRoot?: string;
}): Promise<TaskFileResolver> {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot;
  const inspector = new HashPlanInspector(
    options.projectGraph,
    workspaceRoot,
    options.nxJson
  );
  await inspector.init();

  const inputsCache = new Map<string, string[]>();
  const outputsCache = new Map<string, string[]>();

  function parseTaskId(taskId: string): {
    project: string;
    target: string;
    configuration?: string;
  } {
    const [project, target, configuration] = splitByColons(taskId);
    if (!project || !target) {
      throw new Error(
        `Invalid taskId "${taskId}" — expected "project:target[:configuration]"`
      );
    }
    return { project, target, configuration };
  }

  function getInputs(taskId: string): string[] {
    const cached = inputsCache.get(taskId);
    if (cached !== undefined) return cached;

    const { project, target, configuration } = parseTaskId(taskId);

    let result: Record<string, { files?: string[] }> = {};
    try {
      result = inspector.inspectTaskInputs({ project, target, configuration });
    } catch {
      // Project / target not found in graph — treat as no inputs.
    }

    // The result key is usually the same as taskId but may include a
    // defaultConfiguration suffix when none was explicitly given.
    let files: string[] = result[taskId]?.files ?? [];
    if (!result[taskId]) {
      const prefix = `${project}:${target}`;
      for (const [key, inputs] of Object.entries(result)) {
        if (key === prefix || key.startsWith(prefix + ':')) {
          files = inputs.files ?? [];
          break;
        }
      }
    }

    inputsCache.set(taskId, files);
    return files;
  }

  function getOutputs(taskId: string): string[] {
    const cached = outputsCache.get(taskId);
    if (cached !== undefined) return cached;

    const { project, target, configuration } = parseTaskId(taskId);
    const node = options.projectGraph.nodes[project];
    const outputs = node?.data?.targets?.[target]
      ? getOutputsForTargetAndConfiguration(
          { project, target, configuration },
          {},
          node
        )
      : [];

    outputsCache.set(taskId, outputs);
    return outputs;
  }

  return {
    getInputs,
    getOutputs,
    isInput(taskId: string, path: string): boolean {
      return getInputs(taskId).includes(path);
    },
    isOutput(taskId: string, path: string): boolean {
      const normalized = path.replace(/\\/g, '/');
      return getOutputs(taskId).some((pattern) => {
        const normalizedPattern = pattern.replace(/\\/g, '/');
        return (
          normalized === normalizedPattern ||
          normalized.startsWith(normalizedPattern + '/') ||
          minimatch(normalized, normalizedPattern, { dot: true })
        );
      });
    },
  };
}

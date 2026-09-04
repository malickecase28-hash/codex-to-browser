import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../../src/types.js";
import {
  DevOrchestratorError,
  createDevOrchestrator,
  extractVisibleProjectsFromHtml,
  runtimeFromEnvironment,
  type DevPlannerRunRecord,
  type DevPlannerTaskChanges,
  type DevPlannerTaskRecord,
  type DevPlannerTaskSpec,
  type DevProjectChanges,
  type DevProjectContext,
  type DevProjectRecord,
  type DevProjectSpec,
  type DevVisibleBrowserAdapter
} from "../../src/dev/index.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chatgpt-dev-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type FakeOptions = {
  uncertainProjectCreate?: boolean;
  runNow?: boolean;
};

function fakeAdapter(options: FakeOptions = {}): {
  adapter: DevVisibleBrowserAdapter;
  projects: DevProjectRecord[];
  tasks: DevPlannerTaskRecord[];
  runs: DevPlannerRunRecord[];
  counts: Record<string, number>;
} {
  const projects: DevProjectRecord[] = [];
  const tasks: DevPlannerTaskRecord[] = [];
  const runs: DevPlannerRunRecord[] = [];
  const counts: Record<string, number> = {};

  const tick = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };

  const adapter: DevVisibleBrowserAdapter = {
    async listProjects() {
      tick("listProjects");
      return projects.map(item => ({ ...item }));
    },
    async openProject(_env, project) {
      tick("openProject");
      return { ...project };
    },
    async createProject(_env, spec: DevProjectSpec) {
      tick("createProject");
      const created: DevProjectRecord = {
        projectId: `g-p-project-${projects.length + 1}`,
        name: spec.name,
        url: `https://chatgpt.com/g/g-p-project-${projects.length + 1}/project`,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel })
      };
      projects.push(created);
      if (options.uncertainProjectCreate === true) {
        throw new DevOrchestratorError("mutation_uncertain", "simulated uncertain create");
      }
      return { ...created };
    },
    async updateProject(_env, project, changes: DevProjectChanges) {
      tick("updateProject");
      const index = projects.findIndex(item => item.projectId === project.projectId);
      const updated: DevProjectRecord = {
        ...projects[index]!,
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.instructions === undefined ? {} : { instructions: changes.instructions }),
        ...(changes.defaultModel === undefined ? {} : { defaultModel: changes.defaultModel })
      };
      projects[index] = updated;
      return { ...updated };
    },
    async deleteProject(_env, project) {
      tick("deleteProject");
      const index = projects.findIndex(item => item.projectId === project.projectId);
      if (index >= 0) projects.splice(index, 1);
    },
    async listProjectChats() {
      return [];
    },
    async openProjectChat(_env, _project, chat) {
      return chat;
    },
    async inspectProjectContext(_env, project): Promise<DevProjectContext> {
      return { project, sources: [], observedAt: "2026-09-04T21:00:00.000Z" };
    },
    async inspectPlanner() {
      return { supported: true, url: "https://chatgpt.com/tasks", observedAt: "2026-09-04T21:00:00.000Z" };
    },
    async listPlannerTasks() {
      tick("listPlannerTasks");
      return tasks.map(item => ({ ...item }));
    },
    async createPlannerTask(_env, spec: DevPlannerTaskSpec) {
      tick("createPlannerTask");
      const created: DevPlannerTaskRecord = {
        taskId: `task-${tasks.length + 1}`,
        name: spec.name,
        prompt: spec.prompt,
        schedule: spec.schedule,
        enabled: spec.enabled ?? true,
        ...(spec.timezone === undefined ? {} : { timezone: spec.timezone }),
        ...(spec.model === undefined ? {} : { model: spec.model })
      };
      tasks.push(created);
      return { ...created };
    },
    async updatePlannerTask(_env, task, changes: DevPlannerTaskChanges) {
      tick("updatePlannerTask");
      const index = tasks.findIndex(item => item.taskId === task.taskId);
      const updated: DevPlannerTaskRecord = {
        ...tasks[index]!,
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.prompt === undefined ? {} : { prompt: changes.prompt }),
        ...(changes.schedule === undefined ? {} : { schedule: changes.schedule }),
        ...(changes.timezone === undefined ? {} : { timezone: changes.timezone }),
        ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
        ...(changes.model === undefined ? {} : { model: changes.model })
      };
      tasks[index] = updated;
      return { ...updated };
    },
    async deletePlannerTask(_env, task) {
      tick("deletePlannerTask");
      const index = tasks.findIndex(item => item.taskId === task.taskId);
      if (index >= 0) tasks.splice(index, 1);
    },
    async setPlannerTaskEnabled(_env, task, enabled) {
      tick("setPlannerTaskEnabled");
      const index = tasks.findIndex(item => item.taskId === task.taskId);
      const updated = { ...tasks[index]!, enabled };
      tasks[index] = updated;
      return { ...updated };
    },
    async listPlannerRuns(_env, task) {
      return runs.filter(run => run.taskId === task.taskId).map(run => ({ ...run }));
    },
    ...(options.runNow === true ? {
      async runPlannerTaskNow(_env: RuntimeEnv, task: DevPlannerTaskRecord) {
        tick("runPlannerTaskNow");
        const run: DevPlannerRunRecord = {
          runId: `run-${runs.length + 1}`,
          taskId: task.taskId,
          status: "completed",
          completedAt: "2026-09-04T21:00:00.000Z"
        };
        runs.push(run);
        return { ...run };
      }
    } : {})
  };

  return { adapter, projects, tasks, runs, counts };
}

describe("development orchestrator", () => {
  it("creates a Project exactly once for a repeated idempotent request", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const spec: DevProjectSpec = { name: "Compiler", description: "Project context", idempotencyKey: "project-create-1" };
    const first = await dev.projects.create(spec);
    const second = await dev.projects.create(spec);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.data?.receipt.status).toBe("committed");
    expect(second.data?.receipt.receiptId).toBe(first.data?.receipt.receiptId);
    expect(fake.counts.createProject).toBe(1);
    expect(fake.projects).toHaveLength(1);
  });

  it("reconciles an uncertain Project create without resubmitting the mutation", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter({ uncertainProjectCreate: true });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const result = await dev.projects.create({ name: "Runtime", idempotencyKey: "uncertain-create" });

    expect(result.ok).toBe(true);
    expect(result.data?.receipt.status).toBe("reconciled");
    expect(fake.counts.createProject).toBe(1);
    expect(fake.projects).toHaveLength(1);
  });

  it("blocks an ambiguous exact Project name instead of guessing", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.projects.push(
      { projectId: "g-p-one", name: "Build", url: "https://chatgpt.com/g/g-p-one/project" },
      { projectId: "g-p-two", name: "Build", url: "https://chatgpt.com/g/g-p-two/project" }
    );
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const result = await dev.projects.get({ name: "Build" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("dev_ambiguous_match");
  });

  it("sets planner enabled state once and reuses its durable receipt", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.tasks.push({ taskId: "task-1", name: "Nightly", enabled: false });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const first = await dev.planner.setEnabled("task-1", true, { idempotencyKey: "enable-nightly" });
    const second = await dev.planner.setEnabled("task-1", true, { idempotencyKey: "enable-nightly" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.data?.value.enabled).toBe(true);
    expect(second.data?.receipt.receiptId).toBe(first.data?.receipt.receiptId);
    expect(fake.counts.setPlannerTaskEnabled).toBe(1);
  });

  it("fails closed when the visible planner does not expose run-now", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.tasks.push({ taskId: "task-1", name: "Nightly", enabled: true });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const result = await dev.planner.runNow("task-1");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unsupported");
    expect(result.blocker?.code).toBe("dev_ui_unsupported");
  });

  it("persists worker start and stop transitions", async () => {
    const root = await stateRoot();
    const fake = fakeAdapter();
    fake.projects.push({ projectId: "g-p-one", name: "Build", url: "https://chatgpt.com/g/g-p-one/project" });
    fake.tasks.push({ taskId: "task-1", name: "Nightly", enabled: true });
    const dev = createDevOrchestrator(runtimeFromEnvironment({}), { stateRoot: root, adapter: fake.adapter });

    const started = await dev.worker.start({
      name: "Build worker",
      plannerTaskRef: "task-1",
      projectRef: "g-p-one",
      runPolicy: { enabled: false }
    });
    expect(started.ok).toBe(true);
    expect(started.data?.status).toBe("running");

    const stopped = await dev.worker.stop(started.data!.workerId);
    expect(stopped.ok).toBe(true);
    expect(stopped.data?.status).toBe("stopped");

    const workers = JSON.parse(await readFile(join(root, "workers.json"), "utf8")) as { records: Array<{ status: string }> };
    expect(workers.records).toHaveLength(1);
    expect(workers.records[0]?.status).toBe("stopped");
  });

  it("extracts visible Project links without reading hidden application state", () => {
    const records = extractVisibleProjectsFromHtml(`
      <nav>
        <a href="/g/g-p-alpha/project">Alpha</a>
        <a href="https://chatgpt.com/g/g-p-beta/project"> Beta </a>
        <a href="/c/not-a-project">Ignore</a>
      </nav>
    `);

    expect(records).toEqual([
      { projectId: "g-p-alpha", name: "Alpha", url: "https://chatgpt.com/g/g-p-alpha/project" },
      { projectId: "g-p-beta", name: "Beta", url: "https://chatgpt.com/g/g-p-beta/project" }
    ]);
  });
});

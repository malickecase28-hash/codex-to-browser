from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one planning identity patch site in {path}, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    'import {\n  DevAutonomousStoreError,\n  FileDevAutonomousWorkflowStore\n} from "./autonomous-store.js";\n',
    'import {\n  DevAutonomousStoreError,\n  FileDevAutonomousWorkflowStore\n} from "./autonomous-store.js";\n'
    'import { FileDevAutonomousPlanningSpecStore } from "./autonomous-planning-store.js";\n',
)
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '  planner?: DevAutonomousPlannerPort;\n  local?: DevAutonomousLocalPort;\n',
    '  planner?: DevAutonomousPlannerPort;\n  planningStore?: FileDevAutonomousPlanningSpecStore;\n  local?: DevAutonomousLocalPort;\n',
)
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '  const planner = options.planner;\n',
    '  const planner = options.planner;\n'
    '  const planningStore = options.planningStore ?? new FileDevAutonomousPlanningSpecStore({\n'
    '    stateRoot: `${options.store.stateRoot}-planning-specs`\n'
    '  });\n',
)
replace_once(
    "packages/node/src/dev/autonomous-api.ts",
    '    plan: async (spec, planningOptions) => requirePlanner().planWorkflow(spec, planningOptions),\n'
    '    bootstrap: async (spec, planningOptions) => {\n'
    '      try {\n'
    '        const existing = await engine.get(spec.workflowId);\n'
    '        if (\n'
    '          existing.projectKey !== spec.projectKey\n'
    '          || existing.plannerConversationKey !== spec.plannerConversationKey\n'
    '        ) {\n'
    '          throw new DevAutonomousPortError(\n'
    '            "workflow_identity_mismatch",\n'
    '            false,\n'
    '            "An existing autonomous workflow ID belongs to a different Project or planner conversation."\n'
    '          );\n'
    '        }\n'
    '        return existing;\n'
    '      } catch (error) {\n'
    '        if (!(error instanceof DevAutonomousStoreError) || error.code !== "workflow_not_found") throw error;\n'
    '      }\n'
    '      const plan = await requirePlanner().planWorkflow(spec, planningOptions);\n',
    '    plan: async (spec, planningOptions) => {\n'
    '      const plannerPort = requirePlanner();\n'
    '      await planningStore.claim(spec);\n'
    '      return plannerPort.planWorkflow(spec, planningOptions);\n'
    '    },\n'
    '    bootstrap: async (spec, planningOptions) => {\n'
    '      try {\n'
    '        const existing = await engine.get(spec.workflowId);\n'
    '        const identity = await planningStore.get(spec.workflowId);\n'
    '        if (identity === undefined) {\n'
    '          throw new DevAutonomousPortError(\n'
    '            "workflow_identity_mismatch",\n'
    '            false,\n'
    '            "The existing workflow has no immutable master-planning identity. Use a new workflow ID instead of retroactively binding an objective."\n'
    '          );\n'
    '        }\n'
    '        await planningStore.claim(spec);\n'
    '        if (\n'
    '          existing.projectKey !== spec.projectKey\n'
    '          || existing.plannerConversationKey !== spec.plannerConversationKey\n'
    '        ) {\n'
    '          throw new DevAutonomousPortError(\n'
    '            "workflow_identity_mismatch",\n'
    '            false,\n'
    '            "An existing autonomous workflow ID belongs to a different Project or planner conversation."\n'
    '          );\n'
    '        }\n'
    '        return existing;\n'
    '      } catch (error) {\n'
    '        if (!(error instanceof DevAutonomousStoreError) || error.code !== "workflow_not_found") throw error;\n'
    '      }\n'
    '      const plannerPort = requirePlanner();\n'
    '      await planningStore.claim(spec);\n'
    '      const plan = await plannerPort.planWorkflow(spec, planningOptions);\n',
)

replace_once(
    "packages/node/src/dev/index.ts",
    'export * from "./autonomous-planner.js";\n',
    'export * from "./autonomous-planner.js";\nexport * from "./autonomous-planning-store.js";\n',
)

# Add API-level proof that objective drift is rejected before a second planner
# call and that manually-created workflows cannot be silently rebound to a
# planner objective after the fact.
replace_once(
    "packages/node/tests/unit/dev-autonomous-api.test.ts",
    '  it("fails closed when master planning was not configured", async () => {\n',
    '  it("rejects planning-spec drift before a second master-planner turn", async () => {\n'
    '    const planning = planner();\n'
    '    const value = await api({ planner: planning, local: local() });\n'
    '    await value.bootstrap(planningSpec());\n\n'
    '    await expect(value.bootstrap({\n'
    '      ...planningSpec(),\n'
    '      objective: "A different objective must use a different workflow ID."\n'
    '    })).rejects.toMatchObject({ code: "planner_identity_mismatch" });\n'
    '    expect(planning.planWorkflow).toHaveBeenCalledTimes(1);\n'
    '  });\n\n'
    '  it("does not retroactively bind a planner objective to a manually-created workflow", async () => {\n'
    '    const planning = planner();\n'
    '    const value = await api({ planner: planning, local: local() });\n'
    '    await value.create(plan());\n\n'
    '    await expect(value.bootstrap(planningSpec())).rejects.toMatchObject({\n'
    '      blockerCode: "workflow_identity_mismatch"\n'
    '    });\n'
    '    expect(planning.planWorkflow).not.toHaveBeenCalled();\n'
    '  });\n\n'
    '  it("fails closed when master planning was not configured", async () => {\n',
)

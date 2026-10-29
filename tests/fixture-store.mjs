import { createStore } from "../server/store.mjs";
import { createSqlitePersistence } from "../server/persistence.mjs";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureNode = (id, title, ownerRole, dependsOn, extra = {}) => ({ id, title, ownerRole, dependsOn, deliverable: `完成${title}并交付可验收文件。`, artifactPaths: [`docs/${id}/`], ...extra });
const fixtureAgent = (id, name, role, color, system = false) => ({ id, name, role, initials: name.slice(0, 2).toUpperCase(), color, description: `${role}的测试员工。`, kind: system ? "manager" : "business", systemPrompt: `${role}：按提示词评估交接、完成目标，信息不足时向匹配成员咨询。`, capabilities: [], runtime: { provider: "claude-code" }, allowedTools: [], status: "active", system, createdAt: new Date().toISOString() });

// A legacy catalog is an explicit test fixture, not production initialization.
// Stable identities keep historical/session/security tests independent of examples
// shown to a newly installed user. Loading it exercises the real migration path.
function catalogSnapshot() {
  return {
    agents: [fixtureAgent("agent_analyst", "Noah · 需求分析师", "需求分析师", "cyan"), fixtureAgent("agent_designer", "Lena · 产品设计师", "产品设计师", "amber"), fixtureAgent("agent_engineer", "Kai · 研发工程师", "研发工程师", "blue"), fixtureAgent("agent_tester", "Sora · 测试工程师", "测试工程师", "green"), fixtureAgent("system_project_manager", "项目经理", "流程控制", "violet", true)],
    teams: [{ id: "team_product_delivery", name: "产品交付小队", mission: "测试目录：真实文件交付", memberAgentIds: ["agent_analyst", "agent_designer", "agent_engineer", "agent_tester"], managerAgentId: "system_project_manager", policyProfile: "local-bypass-authorized", status: "active", createdAt: new Date().toISOString() }],
    workflowTemplates: [
      { id: "software_delivery", system: true, name: "软件交付", description: "测试目录：需求、设计、开发、测试、修复和回归。", nodes: [fixtureNode("requirements", "需求与验收标准", "需求分析师", []), fixtureNode("design", "方案与交互设计", "产品设计师", ["requirements"]), fixtureNode("development", "功能开发", "研发工程师", ["design"], { repositoryPath: "repos/app" }), fixtureNode("testing", "质量验证与缺陷清单", "测试工程师", ["development"], { repositoryPath: "repos/app" }), fixtureNode("bug_fix", "缺陷修复", "研发工程师", ["testing"], { repositoryPath: "repos/app", artifactPaths: ["docs/development/"], reuseOwnerFrom: "development" }), fixtureNode("regression", "回归验证", "测试工程师", ["bug_fix"], { repositoryPath: "repos/app", artifactPaths: ["docs/testing/"] })] },
      { id: "bug_fix", system: true, name: "缺陷修复", description: "测试目录：复现、设计、修复与验证。", nodes: [fixtureNode("reproduce", "问题复现", "测试工程师", []), fixtureNode("fix_design", "修复方案", "产品设计师", ["reproduce"]), fixtureNode("fix_implementation", "修复实现", "研发工程师", ["fix_design"]), fixtureNode("verify_fix", "修复验证", "测试工程师", ["fix_implementation"])] },
      { id: "content_delivery", system: true, name: "内容交付", description: "测试目录：内容简报、创作编辑与独立审校。", nodes: [fixtureNode("content_brief", "内容简报与验收标准", "需求分析师", [], { artifactPaths: ["docs/content-brief/"] }), fixtureNode("content_creation", "内容创作与编辑", "产品设计师", ["content_brief"], { artifactPaths: ["docs/content/"] }), fixtureNode("content_review", "内容审校与质量核查", "测试工程师", ["content_creation"], { artifactPaths: ["docs/content-review/"] })] }
    ],
    tasks: [], runs: [], traces: [], artifacts: [], messages: [], decisions: [], defects: [], events: []
  };
}

export function createCatalogFixtureStore(options = {}) {
  const databasePath = options.databasePath && options.databasePath !== ":memory:" ? options.databasePath : join(mkdtempSync(join(tmpdir(), "af-catalog-fixture-")), "state.sqlite");
  if (!existsSync(databasePath)) {
    const persistence = createSqlitePersistence(databasePath);
    try { persistence.save(catalogSnapshot()); } finally { persistence.close(); }
  }
  return createStore({ ...options, databasePath });
}

// Explicit test-only sample. Production installations start with no Tasks/Teams.
export function createFixtureStore(options) {
  const existing = options?.databasePath && options.databasePath !== ":memory:" && existsSync(options.databasePath);
  const store = createCatalogFixtureStore(options);
  if (!existing && !store.listTasks().length) store.createTask({
    title: "Fixture task", objective: "Test-only task created through Store commands",
    ...(!store.getWorkspaceSettings().workspaceRoot ? { workspacePath: mkdtempSync(join(tmpdir(), "af-domain-fixture-")) } : {}),
    teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery",
    nodeAssignments: { requirements: "agent_analyst", design: "agent_designer", development: "agent_engineer", testing: "agent_tester", bug_fix: "agent_engineer", regression: "agent_tester" }
  });
  return store;
}

export function fixtureTaskInput(store) {
  const { repositorySources, ...input } = store.listTasks()[0];
  return input;
}

/**
 * Gateway 启动自动检查未完成任务
 * 
 * 功能：
 * 1. Gateway 启动时触发检查
 * 2. 检查未完成的任务列表
 * 3. 检查各 Agent 的任务状态
 * 4. 超时任务告警
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadTaskStore, listTasks } from "./task-store";
import { loadProjectStore, listProjects } from "./project-store";

const RUNTIME_DIR = join(process.cwd(), "runtime");
export const STARTUP_CHECK_LOG_PATH = join(RUNTIME_DIR, "gateway-startup-check.log");

export interface StartupCheckResult {
  checkedAt: string;
  gatewayStatus: "starting" | "running" | "stopped";
  tasks: {
    total: number;
    todo: number;
    inProgress: number;
    blocked: number;
    overdue: number;
  };
  agents: {
    id: string;
    name: string;
    activeTasks: number;
    status: "idle" | "busy" | "blocked";
  }[];
  alerts: StartupAlert[];
  recommendations: string[];
}

export interface StartupAlert {
  level: "critical" | "warn" | "info";
  code: string;
  message: string;
  source: string;
  sourceId: string;
}

export interface StartupCheckOptions {
  gatewayStatus?: "starting" | "running" | "stopped";
  overdueThresholdMs?: number; // 超时阈值，默认 24 小时
}

const DEFAULT_OVERDUE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 执行 Gateway 启动检查
 */
export async function runGatewayStartupCheck(
  options: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  const checkedAt = new Date().toISOString();
  const gatewayStatus = options.gatewayStatus ?? "starting";
  const overdueThresholdMs = options.overdueThresholdMs ?? DEFAULT_OVERDUE_THRESHOLD_MS;

  const taskStore = await loadTaskStore();
  const projectStore = await loadProjectStore();
  const projectTitleById = new Map(
    listProjects(projectStore).map((p) => [p.projectId, p.title]),
  );
  const tasks = listTasks(taskStore, projectTitleById);

  // 统计任务状态
  const nowMs = Date.now();
  const todoTasks = tasks.filter((t) => t.status === "todo");
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress");
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const overdueTasks = tasks.filter((t) => {
    if (!t.dueAt || t.status === "done") return false;
    return nowMs - Date.parse(t.dueAt) > overdueThresholdMs;
  });

  // 按 Agent 统计任务
  const agentTaskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "done") continue;
    const owner = task.owner || "unassigned";
    const count = agentTaskCounts.get(owner) || 0;
    agentTaskCounts.set(owner, count + 1);
  }

  // 构建 Agent 状态列表
  const configuredAgents = [
    { id: "main", name: "智能助手" },
    { id: "pm", name: "项目经理" },
    { id: "architect", name: "架构师" },
    { id: "backend", name: "后端开发" },
    { id: "frontend", name: "前端开发" },
    { id: "designer", name: "设计师" },
    { id: "product", name: "产品经理" },
    { id: "test", name: "测试工程师" },
    { id: "ops", name: "运维工程师" },
  ];

  const agents = configuredAgents.map((agent) => {
    const activeTasks = agentTaskCounts.get(agent.id) || 0;
    const isBlocked = blockedTasks.some((t) => t.owner === agent.id);
    let status: "idle" | "blocked" | "busy" = "idle";
    if (activeTasks > 0) {
      status = isBlocked ? "blocked" : "busy";
    }
    return {
      id: agent.id,
      name: agent.name,
      activeTasks,
      status,
    };
  });

  // 生成告警
  const alerts: StartupAlert[] = [];

  if (overdueTasks.length > 0) {
    alerts.push({
      level: "critical",
      code: "TASKS_OVERDUE",
      message: `${overdueTasks.length} 个任务已超时`,
      source: "task",
      sourceId: "overdue",
    });
  }

  if (blockedTasks.length > 0) {
    alerts.push({
      level: "warn",
      code: "TASKS_BLOCKED",
      message: `${blockedTasks.length} 个任务被阻塞`,
      source: "task",
      sourceId: "blocked",
    });
  }

  if (todoTasks.length > 10) {
    alerts.push({
      level: "info",
      code: "BACKLOG_LARGE",
      message: `待办任务堆积 (${todoTasks.length} 个)`,
      source: "task",
      sourceId: "todo",
    });
  }

  // 生成建议
  const recommendations: string[] = [];
  if (overdueTasks.length > 0) {
    recommendations.push("优先处理超时任务");
  }
  if (blockedTasks.length > 0) {
    recommendations.push("检查阻塞任务的原因");
  }
  const busyAgents = agents.filter((a) => a.status === "busy");
  if (busyAgents.length > 0) {
    recommendations.push(`忙碌的 Agent: ${busyAgents.map((a) => a.name).join(", ")}`);
  }

  const result: StartupCheckResult = {
    checkedAt,
    gatewayStatus,
    tasks: {
      total: tasks.length,
      todo: todoTasks.length,
      inProgress: inProgressTasks.length,
      blocked: blockedTasks.length,
      overdue: overdueTasks.length,
    },
    agents,
    alerts,
    recommendations,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(STARTUP_CHECK_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

  console.log("[gateway-startup-check] check completed", {
    tasks: result.tasks,
    alerts: result.alerts.length,
    recommendations: result.recommendations.length,
  });

  return result;
}

/**
 * 读取最近的启动检查记录
 */
export async function readRecentStartupChecks(limit = 10): Promise<StartupCheckResult[]> {
  try {
    const raw = await readFile(STARTUP_CHECK_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: StartupCheckResult[] = [];
    
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as StartupCheckResult;
        if (parsed && typeof parsed.checkedAt === "string") {
          results.push(parsed);
        }
      } catch {
        continue;
      }
    }
    
    return results;
  } catch {
    return [];
  }
}
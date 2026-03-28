/**
 * Agent 任务执行日志
 * 
 * 功能：
 * 1. 记录 Agent 执行任务的完整生命周期
 * 2. 记录开始时间、结束时间、执行状态
 * 3. 支持错误信息记录
 * 4. 提供日志查询接口
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_DIR = join(process.cwd(), "runtime");
export const AGENT_ACTIVITY_LOG_PATH = join(RUNTIME_DIR, "agent-activity.log");

export type ActivityStatus = "started" | "completed" | "failed" | "cancelled" | "timeout";

export interface AgentActivityEntry {
  // 基础信息
  entryId: string;
  timestamp: string;
  
  // Agent 信息
  agentId: string;
  agentName: string;
  
  // 任务信息
  taskId: string;
  taskTitle: string;
  projectId?: string;
  projectTitle?: string;
  
  // 执行状态
  status: ActivityStatus;
  
  // 时间记录
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  
  // 结果
  success?: boolean;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  
  // 元数据
  metadata?: Record<string, unknown>;
}

export interface LogActivityOptions {
  agentId: string;
  agentName?: string;
  taskId: string;
  taskTitle?: string;
  projectId?: string;
  projectTitle?: string;
  status: ActivityStatus;
  startedAt?: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}

// Agent 名称映射
const AGENT_NAMES: Record<string, string> = {
  main: "智能助手",
  pm: "项目经理",
  architect: "架构师",
  backend: "后端开发",
  frontend: "前端开发",
  designer: "设计师",
  product: "产品经理",
  test: "测试工程师",
  ops: "运维工程师",
};

/**
 * 记录 Agent 活动
 */
export async function logAgentActivity(options: LogActivityOptions): Promise<AgentActivityEntry> {
  const entryId = generateEntryId();
  const timestamp = new Date().toISOString();
  const agentName = options.agentName ?? AGENT_NAMES[options.agentId] ?? options.agentId;
  
  // 计算持续时间
  let durationMs: number | undefined;
  if (options.startedAt && options.completedAt) {
    durationMs = Date.parse(options.completedAt) - Date.parse(options.startedAt);
  }
  
  // 判断成功状态
  const success = options.status === "completed" ? true : options.status === "failed" ? false : undefined;
  
  const entry: AgentActivityEntry = {
    entryId,
    timestamp,
    agentId: options.agentId,
    agentName,
    taskId: options.taskId,
    taskTitle: options.taskTitle ?? options.taskId,
    projectId: options.projectId,
    projectTitle: options.projectTitle,
    status: options.status,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    durationMs,
    success,
    error: options.error,
    metadata: options.metadata,
  };
  
  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(AGENT_ACTIVITY_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  
  console.log("[agent-activity] logged", {
    entryId,
    agentId: entry.agentId,
    taskId: entry.taskId,
    status: entry.status,
    durationMs: entry.durationMs,
  });
  
  return entry;
}

/**
 * 记录任务开始
 */
export async function logTaskStarted(
  agentId: string,
  taskId: string,
  taskTitle?: string,
  projectId?: string,
  projectTitle?: string,
): Promise<AgentActivityEntry> {
  const startedAt = new Date().toISOString();
  
  return logAgentActivity({
    agentId,
    taskId,
    taskTitle,
    projectId,
    projectTitle,
    status: "started",
    startedAt,
  });
}

/**
 * 记录任务完成
 */
export async function logTaskCompleted(
  agentId: string,
  taskId: string,
  startedAt: string,
  taskTitle?: string,
  projectId?: string,
  projectTitle?: string,
  metadata?: Record<string, unknown>,
): Promise<AgentActivityEntry> {
  const completedAt = new Date().toISOString();
  
  return logAgentActivity({
    agentId,
    taskId,
    taskTitle,
    projectId,
    projectTitle,
    status: "completed",
    startedAt,
    completedAt,
    metadata,
  });
}

/**
 * 记录任务失败
 */
export async function logTaskFailed(
  agentId: string,
  taskId: string,
  startedAt: string,
  error: { code: string; message: string; stack?: string },
  taskTitle?: string,
  projectId?: string,
  projectTitle?: string,
): Promise<AgentActivityEntry> {
  const completedAt = new Date().toISOString();
  
  return logAgentActivity({
    agentId,
    taskId,
    taskTitle,
    projectId,
    projectTitle,
    status: "failed",
    startedAt,
    completedAt,
    error,
  });
}

/**
 * 查询 Agent 活动日志
 */
export interface QueryActivitiesOptions {
  agentId?: string;
  taskId?: string;
  status?: ActivityStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ActivitiesQueryResult {
  path: string;
  total: number;
  entries: AgentActivityEntry[];
}

export async function queryAgentActivities(
  options: QueryActivitiesOptions = {},
): Promise<ActivitiesQueryResult> {
  const limit = Math.min(options.limit ?? 100, 500);
  
  try {
    const raw = await readFile(AGENT_ACTIVITY_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    
    const entries: AgentActivityEntry[] = [];
    const fromMs = options.from ? Date.parse(options.from) : 0;
    const toMs = options.to ? Date.parse(options.to) : Date.now();
    
    // 从最新的记录开始查询
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]) as AgentActivityEntry;
        
        // 过滤条件
        if (options.agentId && entry.agentId !== options.agentId) continue;
        if (options.taskId && entry.taskId !== options.taskId) continue;
        if (options.status && entry.status !== options.status) continue;
        
        const entryMs = Date.parse(entry.timestamp);
        if (entryMs < fromMs || entryMs > toMs) continue;
        
        entries.push(entry);
      } catch {
        continue;
      }
    }
    
    return {
      path: AGENT_ACTIVITY_LOG_PATH,
      total: lines.length,
      entries,
    };
  } catch {
    return {
      path: AGENT_ACTIVITY_LOG_PATH,
      total: 0,
      entries: [],
    };
  }
}

/**
 * 获取 Agent 活动统计
 */
export interface AgentActivityStats {
  agentId: string;
  agentName: string;
  totalActivities: number;
  completed: number;
  failed: number;
  avgDurationMs: number;
  lastActivityAt?: string;
}

export async function getAgentActivityStats(
  agentId?: string,
): Promise<AgentActivityStats[]> {
  const result = await queryAgentActivities({ limit: 500 });
  
  // 按 Agent 统计
  const statsMap = new Map<string, AgentActivityStats>();
  
  for (const entry of result.entries) {
    const id = entry.agentId;
    const stats = statsMap.get(id) ?? {
      agentId: id,
      agentName: entry.agentName,
      totalActivities: 0,
      completed: 0,
      failed: 0,
      avgDurationMs: 0,
      lastActivityAt: undefined,
    };
    
    stats.totalActivities++;
    if (entry.status === "completed") stats.completed++;
    if (entry.status === "failed") stats.failed++;
    if (entry.durationMs) {
      stats.avgDurationMs = (stats.avgDurationMs * (stats.totalActivities - 1) + entry.durationMs) / stats.totalActivities;
    }
    if (!stats.lastActivityAt || entry.timestamp > stats.lastActivityAt) {
      stats.lastActivityAt = entry.timestamp;
    }
    
    statsMap.set(id, stats);
  }
  
  // 过滤指定的 Agent
  if (agentId) {
    const stats = statsMap.get(agentId);
    return stats ? [stats] : [];
  }
  
  return Array.from(statsMap.values()).sort((a, b) => b.totalActivities - a.totalActivities);
}

/**
 * 生成唯一的 entry ID
 */
function generateEntryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `act-${timestamp}-${random}`;
}
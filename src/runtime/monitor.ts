import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawReadonlyAdapter } from "../adapters/openclaw-readonly";
import { POLLING_INTERVALS_MS } from "../config";
import { commanderAlerts } from "./commander";
import { writeCommanderDigest } from "./commander-digest";
import { formatDiffSummary } from "./diff-summary";
import { saveSnapshot } from "./snapshot-store";
import { runTaskHeartbeat } from "./task-heartbeat";
import { logAgentActivity } from "./agent-activity-log";
import { runGatewayStartupCheck } from "./gateway-startup-check";

const RUNTIME_DIR = join(process.cwd(), "runtime");
const TIMELINE_LOG = join(RUNTIME_DIR, "timeline.log");
const ACTIVITY_STATE_FILE = join(RUNTIME_DIR, "activity-state.json");

// 跟踪已记录的 session 状态
interface SessionState {
  sessionKey: string;
  agentId: string;
  lastMessageAt: string;
  state: string;
  messageCount: number;
}

let previousSessions: SessionState[] = [];

export async function runMonitorOnce(adapter: OpenClawReadonlyAdapter): Promise<void> {
  const snapshot = await adapter.snapshot();
  const stored = await saveSnapshot(snapshot);
  const alerts = commanderAlerts(snapshot);
  const digest = await writeCommanderDigest(snapshot, alerts);
  const heartbeat = await runTaskHeartbeat();
  const heartbeatSummary = `heartbeat=${heartbeat.mode}:${heartbeat.executed}/${heartbeat.selected}`;

  // 自动记录 Agent 活动
  await trackAgentActivities(snapshot);

  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(
    TIMELINE_LOG,
    `${new Date().toISOString()} | ${formatDiffSummary(stored.diff)} | alerts=${alerts.length} | ${heartbeatSummary}\n`,
    "utf8",
  );

  console.log("[mission-control] monitor", {
    diffSummary: formatDiffSummary(stored.diff),
    alerts,
    heartbeat,
    timelineLog: TIMELINE_LOG,
    digestJson: digest.jsonPath,
    digestMarkdown: digest.markdownPath,
  });
}

/**
 * 自动追踪 Agent 活动
 */
async function trackAgentActivities(snapshot: import("../types").ReadModelSnapshot): Promise<void> {
  const currentSessions: SessionState[] = snapshot.sessions.map((s) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId || "main",
    lastMessageAt: s.lastMessageAt || "",
    state: s.state || "active",
    messageCount: 0, // snapshot 不包含消息数量，使用时间戳判断
  }));

  // 检测状态变化
  for (const current of currentSessions) {
    const previous = previousSessions.find((p) => p.sessionKey === current.sessionKey);
    
    if (!previous) {
      // 新 session，记录启动
      await logAgentActivity({
        agentId: current.agentId,
        taskId: `session-${current.sessionKey.slice(0, 8)}`,
        taskTitle: `Session started: ${current.sessionKey}`,
        status: "started",
        metadata: { sessionKey: current.sessionKey, state: current.state },
      });
    } else if (previous.state !== current.state && current.state === "completed") {
      // session 完成
      await logAgentActivity({
        agentId: current.agentId,
        taskId: `session-${current.sessionKey.slice(0, 8)}`,
        taskTitle: `Session completed: ${current.sessionKey}`,
        status: "completed",
        startedAt: previous.lastMessageAt,
        completedAt: current.lastMessageAt,
        metadata: { sessionKey: current.sessionKey },
      });
    } else if (previous.state !== current.state && current.state === "error") {
      // session 错误
      await logAgentActivity({
        agentId: current.agentId,
        taskId: `session-${current.sessionKey.slice(0, 8)}`,
        taskTitle: `Session error: ${current.sessionKey}`,
        status: "failed",
        startedAt: previous.lastMessageAt,
        error: { code: "SESSION_ERROR", message: `Session entered error state` },
        metadata: { sessionKey: current.sessionKey },
      });
    }
  }

  previousSessions = currentSessions;
}

export function monitorIntervalMs(): number {
  return POLLING_INTERVALS_MS.sessionsList;
}

/**
 * 初始化监控器（在启动时调用）
 */
export async function initMonitor(adapter: OpenClawReadonlyAdapter): Promise<void> {
  console.log("[mission-control] initializing monitor...");
  
  // 运行启动检查
  const startupResult = await runGatewayStartupCheck({ gatewayStatus: "starting" });
  console.log("[mission-control] startup check completed:", {
    tasks: startupResult.tasks,
    alerts: startupResult.alerts.length,
  });

  // 初始化 session 状态
  const snapshot = await adapter.snapshot();
  previousSessions = snapshot.sessions.map((s) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId || "main",
    lastMessageAt: s.lastMessageAt || "",
    state: s.state || "active",
    messageCount: 0,
  }));

  console.log("[mission-control] monitor initialized, tracking", previousSessions.length, "sessions");
}

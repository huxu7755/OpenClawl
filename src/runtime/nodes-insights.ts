/**
 * Nodes 设备管理模块
 * 
 * 功能：
 * 1. 查看已配对设备状态
 * 2. 管理 pending 请求
 * 3. 执行配对操作
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const NODES_LOG_PATH = join(RUNTIME_DIR, "nodes.log");

export interface NodeDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  status: "paired" | "pending" | "offline" | "unknown";
  pairedAt?: string;
  lastSeenAt?: string;
  scopes?: string[];
  role?: string;
}

export interface PendingRequest {
  requestId: string;
  deviceId: string;
  platform?: string;
  requestedAt: string;
  silent: boolean;
  isRepair: boolean;
}

export interface NodesOverview {
  checkedAt: string;
  pairedNodes: NodeDevice[];
  pendingRequests: PendingRequest[];
  summary: {
    paired: number;
    pending: number;
    offline: number;
  };
}

/**
 * 获取所有设备状态
 */
export async function getNodesOverview(): Promise<NodesOverview> {
  const checkedAt = new Date().toISOString();
  const pairedNodes: NodeDevice[] = [];
  const pendingRequests: PendingRequest[] = [];

  // 读取 paired.json
  const pairedPath = join(homedir(), ".openclaw/devices/paired.json");
  try {
    const pairedRaw = await readFile(pairedPath, "utf8");
    const paired = JSON.parse(pairedRaw);

    for (const [deviceId, device] of Object.entries(paired)) {
      const d = device as Record<string, any>;
      pairedNodes.push({
        deviceId,
        displayName: d.displayName || deviceId.slice(0, 8),
        platform: d.platform,
        status: "paired",
        pairedAt: d.approvedAtMs ? new Date(d.approvedAtMs).toISOString() : undefined,
        scopes: d.tokens?.operator?.scopes || [],
        role: d.tokens?.operator?.role,
      });
    }
  } catch {
    // 文件不存在或解析失败
  }

  // 读取 pending.json
  const pendingPath = join(homedir(), ".openclaw/devices/pending.json");
  try {
    const pendingRaw = await readFile(pendingPath, "utf8");
    const pending = JSON.parse(pendingRaw);

    for (const [requestId, request] of Object.entries(pending)) {
      const r = request as Record<string, any>;
      pendingRequests.push({
        requestId,
        deviceId: r.deviceId,
        platform: r.platform,
        requestedAt: r.ts ? new Date(r.ts).toISOString() : checkedAt,
        silent: r.silent || false,
        isRepair: r.isRepair || false,
      });
    }
  } catch {
    // 文件不存在或解析失败
  }

  const summary = {
    paired: pairedNodes.length,
    pending: pendingRequests.length,
    offline: 0, // 需要通过 Gateway 查询
  };

  const result: NodesOverview = {
    checkedAt,
    pairedNodes,
    pendingRequests,
    summary,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(NODES_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

  return result;
}

/**
 * 批准配对请求
 */
export async function approvePairingRequest(requestId: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["pairing", "approve", requestId], {
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "已批准",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 拒绝配对请求
 */
export async function rejectPairingRequest(requestId: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["pairing", "reject", requestId], {
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "已拒绝",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 重命名设备
 */
export async function renameNode(
  deviceId: string,
  newName: string
): Promise<{ success: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "openclaw",
      ["nodes", "rename", "--node", deviceId, "--name", newName],
      {
        timeout: 15000,
        env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
      }
    );

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "已重命名",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 删除已配对设备
 */
export async function removeNode(deviceId: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["nodes", "remove", deviceId], {
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "已删除",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 读取最近的节点状态记录
 */
export async function readRecentNodesStatus(limit = 10): Promise<NodesOverview[]> {
  try {
    const raw = await readFile(NODES_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: NodesOverview[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as NodesOverview;
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
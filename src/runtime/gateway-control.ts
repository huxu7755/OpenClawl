/**
 * Gateway Control 模块
 * 
 * 功能：
 * 1. 查看 Gateway 状态
 * 2. 启动/停止/重启 Gateway
 * 3. 查看日志
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const GATEWAY_LOG_PATH = join(RUNTIME_DIR, "gateway-control.log");

export interface GatewayStatus {
  checkedAt: string;
  status: "running" | "stopped" | "error" | "unknown";
  pid?: number;
  port: number;
  bind: string;
  uptime?: string;
  connections?: number;
  memory?: string;
  error?: string;
}

export interface GatewayControlResult {
  action: "start" | "stop" | "restart" | "status";
  success: boolean;
  message: string;
  timestamp: string;
  output?: string;
}

/**
 * 获取 Gateway 状态
 */
export async function getGatewayStatus(): Promise<GatewayStatus> {
  const checkedAt = new Date().toISOString();

  try {
    const { stdout } = await execFileAsync("openclaw", ["gateway", "status"], {
      timeout: 10000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    // 解析输出
    const isRunning = stdout.includes("Listening") || stdout.includes("live");
    const pidMatch = stdout.match(/pid\s+(\d+)/i);
    const portMatch = stdout.match(/port\s+(\d+)/i) || stdout.match(/:(\d+)/);
    const bindMatch = stdout.match(/bind\s+(\S+)/i);

    const status: GatewayStatus = {
      checkedAt,
      status: isRunning ? "running" : "stopped",
      pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
      port: portMatch ? parseInt(portMatch[1], 10) : 18789,
      bind: bindMatch ? bindMatch[1] : "loopback",
    };

    // 写入日志
    await mkdir(RUNTIME_DIR, { recursive: true });
    await appendFile(GATEWAY_LOG_PATH, `${JSON.stringify(status)}\n`, "utf8");

    return status;
  } catch (error) {
    return {
      checkedAt,
      status: "error",
      port: 18789,
      bind: "loopback",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 启动 Gateway
 */
export async function startGateway(): Promise<GatewayControlResult> {
  const timestamp = new Date().toISOString();

  try {
    // 使用 spawn 以便后台运行
    const child = spawn("openclaw", ["gateway"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });

    child.unref();

    // 等待一下让进程启动
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result: GatewayControlResult = {
      action: "start",
      success: true,
      message: "Gateway 启动命令已执行",
      timestamp,
    };

    await appendFile(GATEWAY_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

    return result;
  } catch (error) {
    return {
      action: "start",
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
      timestamp,
    };
  }
}

/**
 * 停止 Gateway
 */
export async function stopGateway(): Promise<GatewayControlResult> {
  const timestamp = new Date().toISOString();

  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["gateway", "stop"], {
      timeout: 15000,
    });

    const result: GatewayControlResult = {
      action: "stop",
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "Gateway 已停止",
      timestamp,
      output: stdout + stderr,
    };

    await appendFile(GATEWAY_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

    return result;
  } catch (error) {
    return {
      action: "stop",
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
      timestamp,
    };
  }
}

/**
 * 重启 Gateway
 */
export async function restartGateway(): Promise<GatewayControlResult> {
  const timestamp = new Date().toISOString();

  try {
    // 先停止
    await execFileAsync("openclaw", ["gateway", "stop"], {
      timeout: 15000,
    });

    // 等待一下
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 再启动
    const child = spawn("openclaw", ["gateway"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });

    child.unref();

    // 等待启动
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result: GatewayControlResult = {
      action: "restart",
      success: true,
      message: "Gateway 已重启",
      timestamp,
    };

    await appendFile(GATEWAY_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

    return result;
  } catch (error) {
    return {
      action: "restart",
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
      timestamp,
    };
  }
}

/**
 * 读取最近的 Gateway 控制记录
 */
export async function readRecentGatewayControl(limit = 20): Promise<(GatewayStatus | GatewayControlResult)[]> {
  try {
    const raw = await readFile(GATEWAY_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: (GatewayStatus | GatewayControlResult)[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && (parsed.checkedAt || parsed.timestamp)) {
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

/**
 * 检查 Gateway 健康状态
 */
export async function checkGatewayHealth(): Promise<{
  healthy: boolean;
  responseTime: number;
  message: string;
}> {
  const startTime = Date.now();

  try {
    const { stdout } = await execFileAsync("curl", ["-s", "http://127.0.0.1:18789/health"], {
      timeout: 5000,
    });

    const responseTime = Date.now() - startTime;

    return {
      healthy: stdout.includes("ok") || stdout.includes("live"),
      responseTime,
      message: stdout,
    };
  } catch {
    return {
      healthy: false,
      responseTime: Date.now() - startTime,
      message: "Gateway 无法访问",
    };
  }
}
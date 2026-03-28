/**
 * Channels 频道管理模块
 * 
 * 功能：
 * 1. 查看所有频道状态
 * 2. 管理频道连接（登录/退出）
 * 3. 查看频道配置
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const CHANNELS_LOG_PATH = join(RUNTIME_DIR, "channels.log");

export interface ChannelStatus {
  id: string;
  name: string;
  type: string;
  status: "connected" | "disconnected" | "error" | "unknown";
  accounts: ChannelAccount[];
  lastCheckedAt: string;
  error?: string;
}

export interface ChannelAccount {
  accountId: string;
  name?: string;
  status: "active" | "inactive" | "error";
  groups?: number;
  dms?: number;
}

export interface ChannelsOverview {
  checkedAt: string;
  channels: ChannelStatus[];
  summary: {
    total: number;
    connected: number;
    disconnected: number;
    error: number;
  };
}

// 支持的频道类型
export const SUPPORTED_CHANNELS = [
  { id: "feishu", name: "飞书", icon: "📱" },
  { id: "telegram", name: "Telegram", icon: "✈️" },
  { id: "discord", name: "Discord", icon: "🎮" },
  { id: "whatsapp", name: "WhatsApp", icon: "💬" },
  { id: "slack", name: "Slack", icon: "💼" },
  { id: "signal", name: "Signal", icon: "🔐" },
  { id: "imessage", name: "iMessage", icon: "🍎" },
  { id: "line", name: "LINE", icon: "💚" },
  { id: "wechat", name: "微信", icon: "🟢" },
];

/**
 * 获取所有频道状态
 */
export async function getChannelsOverview(): Promise<ChannelsOverview> {
  const checkedAt = new Date().toISOString();
  const channels: ChannelStatus[] = [];

  // 读取配置文件获取已配置的频道
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  try {
    const configRaw = await readFile(configPath, "utf8");
    // 简单的 JSON5 解析（移除注释）
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const config = JSON.parse(configJson);

    if (config.channels) {
      for (const [channelType, channelConfig] of Object.entries(config.channels)) {
        const channelStatus = await checkChannelStatus(channelType, channelConfig as any);
        channels.push(channelStatus);
      }
    }
  } catch (error) {
    console.error("[channels-insights] failed to read config:", error);
  }

  // 计算统计
  const summary = {
    total: channels.length,
    connected: channels.filter((c) => c.status === "connected").length,
    disconnected: channels.filter((c) => c.status === "disconnected").length,
    error: channels.filter((c) => c.status === "error").length,
  };

  const result: ChannelsOverview = {
    checkedAt,
    channels,
    summary,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(CHANNELS_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

  return result;
}

/**
 * 检查单个频道状态
 */
async function checkChannelStatus(
  channelType: string,
  config: Record<string, any>
): Promise<ChannelStatus> {
  const channelInfo = SUPPORTED_CHANNELS.find((c) => c.id === channelType) || {
    id: channelType,
    name: channelType,
    icon: "📡",
  };

  const accounts: ChannelAccount[] = [];
  let overallStatus: "connected" | "disconnected" | "error" | "unknown" = "unknown";

  // 检查 accounts 配置
  if (config.accounts) {
    for (const [accountId, accountConfig] of Object.entries(config.accounts)) {
      if (accountId === "default") continue;

      const account = accountConfig as Record<string, any>;
      const hasCredentials = !!(account.appId || account.botToken || account.apiKey);

      accounts.push({
        accountId,
        name: account.name || accountId,
        status: hasCredentials ? "active" : "inactive",
        groups: account.groups ? Object.keys(account.groups).length : 0,
      });

      if (hasCredentials) {
        overallStatus = "connected";
      }
    }
  }

  // 如果没有账户配置，标记为 disconnected
  if (accounts.length === 0 && !config.accounts?.default) {
    overallStatus = "disconnected";
  }

  return {
    id: channelType,
    name: channelInfo.name,
    type: channelType,
    status: overallStatus,
    accounts,
    lastCheckedAt: new Date().toISOString(),
  };
}

/**
 * 获取频道详细配置
 */
export async function getChannelConfig(channelType: string): Promise<Record<string, any> | null> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  try {
    const configRaw = await readFile(configPath, "utf8");
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const config = JSON.parse(configJson);

    return config.channels?.[channelType] || null;
  } catch {
    return null;
  }
}

/**
 * 执行频道命令
 */
export async function executeChannelCommand(
  channelType: string,
  command: "login" | "logout" | "restart" | "status",
  options?: { accountId?: string }
): Promise<{ success: boolean; message: string; output?: string }> {
  try {
    const args = ["channels", command, "--channel", channelType];

    if (options?.accountId) {
      args.push("--account", options.accountId);
    }

    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      timeout: 30000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "Command executed",
      output: stdout + stderr,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 读取最近的频道状态记录
 */
export async function readRecentChannelsStatus(limit = 10): Promise<ChannelsOverview[]> {
  try {
    const raw = await readFile(CHANNELS_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: ChannelsOverview[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ChannelsOverview;
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
/**
 * Message 消息管理模块
 * 
 * 功能：
 * 1. 发送消息到各频道
 * 2. 查看消息历史
 * 3. 管理消息模板
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const MESSAGE_LOG_PATH = join(RUNTIME_DIR, "messages.log");
const TEMPLATES_PATH = join(RUNTIME_DIR, "message-templates.json");

export interface MessageTarget {
  channel: string;
  target: string;
  accountId?: string;
}

export interface SendMessageOptions {
  channel: string;
  target: string;
  message: string;
  accountId?: string;
  replyTo?: string;
  silent?: boolean;
}

export interface MessageRecord {
  id: string;
  timestamp: string;
  channel: string;
  target: string;
  accountId?: string;
  message: string;
  status: "sent" | "failed" | "pending";
  error?: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  channel: string;
  content: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MessagesOverview {
  checkedAt: string;
  recentMessages: MessageRecord[];
  templates: MessageTemplate[];
  supportedChannels: { id: string; name: string }[];
}

// 支持的频道
export const SUPPORTED_MESSAGE_CHANNELS = [
  { id: "feishu", name: "飞书" },
  { id: "telegram", name: "Telegram" },
  { id: "discord", name: "Discord" },
  { id: "whatsapp", name: "WhatsApp" },
  { id: "slack", name: "Slack" },
  { id: "signal", name: "Signal" },
  { id: "imessage", name: "iMessage" },
  { id: "line", name: "LINE" },
];

/**
 * 发送消息
 */
export async function sendMessage(options: SendMessageOptions): Promise<MessageRecord> {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = new Date().toISOString();
  const record: MessageRecord = {
    id,
    timestamp,
    channel: options.channel,
    target: options.target,
    accountId: options.accountId,
    message: options.message,
    status: "pending",
  };

  try {
    const args = [
      "message",
      "send",
      "--channel", options.channel,
      "--target", options.target,
      "--message", options.message,
    ];

    if (options.accountId) {
      args.push("--account", options.accountId);
    }
    if (options.replyTo) {
      args.push("--reply-to", options.replyTo);
    }
    if (options.silent) {
      args.push("--silent");
    }

    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      timeout: 30000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    record.status = !stderr || !stderr.includes("error") ? "sent" : "failed";
    if (stderr) record.error = stderr;
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : "Unknown error";
  }

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(MESSAGE_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

/**
 * 获取消息概览
 */
export async function getMessagesOverview(): Promise<MessagesOverview> {
  const checkedAt = new Date().toISOString();

  // 读取最近消息
  const recentMessages = await readRecentMessages(20);

  // 读取模板
  const templates = await loadTemplates();

  return {
    checkedAt,
    recentMessages,
    templates,
    supportedChannels: SUPPORTED_MESSAGE_CHANNELS,
  };
}

/**
 * 读取最近消息记录
 */
export async function readRecentMessages(limit = 50): Promise<MessageRecord[]> {
  try {
    const raw = await readFile(MESSAGE_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: MessageRecord[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as MessageRecord;
        if (parsed && parsed.id) {
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
 * 加载消息模板
 */
export async function loadTemplates(): Promise<MessageTemplate[]> {
  try {
    const raw = await readFile(TEMPLATES_PATH, "utf8");
    return JSON.parse(raw) as MessageTemplate[];
  } catch {
    return [];
  }
}

/**
 * 保存消息模板
 */
export async function saveTemplates(templates: MessageTemplate[]): Promise<void> {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(TEMPLATES_PATH, JSON.stringify(templates, null, 2), "utf8");
}

/**
 * 创建消息模板
 */
export async function createTemplate(
  name: string,
  channel: string,
  content: string
): Promise<MessageTemplate> {
  const templates = await loadTemplates();

  // 提取变量 {{variable}}
  const variables = Array.from(content.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]);

  const template: MessageTemplate = {
    id: `tpl-${Date.now()}`,
    name,
    channel,
    content,
    variables,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  templates.push(template);
  await saveTemplates(templates);

  return template;
}

/**
 * 更新消息模板
 */
export async function updateTemplate(
  id: string,
  updates: Partial<Pick<MessageTemplate, "name" | "channel" | "content">>
): Promise<MessageTemplate | null> {
  const templates = await loadTemplates();
  const index = templates.findIndex((t) => t.id === id);

  if (index === -1) return null;

  const updated = {
    ...templates[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  if (updates.content) {
    updated.variables = Array.from(updates.content.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1]);
  }

  templates[index] = updated;
  await saveTemplates(templates);

  return updated;
}

/**
 * 删除消息模板
 */
export async function deleteTemplate(id: string): Promise<boolean> {
  const templates = await loadTemplates();
  const index = templates.findIndex((t) => t.id === id);

  if (index === -1) return false;

  templates.splice(index, 1);
  await saveTemplates(templates);

  return true;
}

/**
 * 使用模板发送消息
 */
export async function sendTemplateMessage(
  templateId: string,
  target: string,
  variables: Record<string, string>,
  accountId?: string
): Promise<MessageRecord> {
  const templates = await loadTemplates();
  const template = templates.find((t) => t.id === templateId);

  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  // 替换变量
  let message = template.content;
  for (const [key, value] of Object.entries(variables)) {
    message = message.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  return sendMessage({
    channel: template.channel,
    target,
    message,
    accountId,
  });
}

/**
 * 获取频道配置
 */
export async function getChannelAccounts(channel: string): Promise<string[]> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  try {
    const configRaw = await readFile(configPath, "utf8");
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const config = JSON.parse(configJson);

    const channelConfig = config.channels?.[channel];
    if (!channelConfig?.accounts) return [];

    return Object.keys(channelConfig.accounts).filter((id) => id !== "default");
  } catch {
    return [];
  }
}
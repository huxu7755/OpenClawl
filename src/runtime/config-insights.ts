/**
 * Config 配置管理模块
 * 
 * 功能：
 * 1. 查看配置
 * 2. 修改配置
 * 3. 配置验证
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const CONFIG_LOG_PATH = join(RUNTIME_DIR, "config.log");

export interface ConfigSection {
  path: string;
  value: any;
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  editable: boolean;
}

export interface ConfigOverview {
  loadedAt: string;
  configPath: string;
  sections: {
    gateway: ConfigSection | null;
    channels: ConfigSection | null;
    agents: ConfigSection | null;
    models: ConfigSection | null;
    plugins: ConfigSection | null;
  };
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
}

/**
 * 获取配置概览
 */
export async function getConfigOverview(): Promise<ConfigOverview> {
  const loadedAt = new Date().toISOString();
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  let config: Record<string, any> = {};
  let validation = { valid: true, errors: [] as string[], warnings: [] as string[] };

  try {
    const configRaw = await readFile(configPath, "utf8");
    // 简单的 JSON5 解析
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    config = JSON.parse(configJson);
  } catch (error) {
    validation.errors.push(`无法读取配置文件: ${error instanceof Error ? error.message : "Unknown error"}`);
    validation.valid = false;
  }

  // 执行配置验证
  try {
    const { stdout } = await execFileAsync("openclaw", ["config", "validate"], {
      timeout: 10000,
    });
    if (!stdout.includes("valid")) {
      validation.warnings.push("配置验证有警告");
    }
  } catch (error) {
    validation.warnings.push(`验证命令执行失败: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  const sections = {
    gateway: config.gateway ? {
      path: "gateway",
      value: maskSensitiveValues(config.gateway),
      type: "object" as const,
      editable: true,
    } : null,
    channels: config.channels ? {
      path: "channels",
      value: maskSensitiveValues(config.channels),
      type: "object" as const,
      editable: true,
    } : null,
    agents: config.agents ? {
      path: "agents",
      value: config.agents,
      type: "object" as const,
      editable: true,
    } : null,
    models: config.models ? {
      path: "models",
      value: maskSensitiveValues(config.models),
      type: "object" as const,
      editable: true,
    } : null,
    plugins: config.plugins ? {
      path: "plugins",
      value: config.plugins,
      type: "object" as const,
      editable: true,
    } : null,
  };

  const result: ConfigOverview = {
    loadedAt,
    configPath,
    sections,
    validation,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(CONFIG_LOG_PATH, `${JSON.stringify({ loadedAt, validation })}\n`, "utf8");

  return result;
}

/**
 * 获取特定配置路径的值
 */
export async function getConfigValue(path: string): Promise<{
  path: string;
  value: any;
  exists: boolean;
}> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  try {
    const configRaw = await readFile(configPath, "utf8");
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const config = JSON.parse(configJson);

    const parts = path.split(".");
    let value: any = config;

    for (const part of parts) {
      if (value && typeof value === "object" && part in value) {
        value = value[part];
      } else {
        return { path, value: undefined, exists: false };
      }
    }

    return { path, value: maskSensitiveValues(value), exists: true };
  } catch {
    return { path, value: undefined, exists: false };
  }
}

/**
 * 设置配置值
 */
export async function setConfigValue(path: string, value: any): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["config", "set", path, JSON.stringify(value)], {
      timeout: 15000,
    });

    return {
      success: !stderr || !stderr.includes("error"),
      message: stdout || stderr || "配置已更新",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 获取配置 Schema
 */
export async function getConfigSchema(path?: string): Promise<{
  schema: any;
  path: string;
}> {
  try {
    const args = ["config", "schema"];
    if (path) args.push(path);

    const { stdout } = await execFileAsync("openclaw", args, {
      timeout: 10000,
    });

    return {
      schema: JSON.parse(stdout),
      path: path || "root",
    };
  } catch (error) {
    return {
      schema: null,
      path: path || "root",
    };
  }
}

/**
 * 验证配置
 */
export async function validateConfig(): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["config", "validate", "--json"], {
      timeout: 15000,
    });

    const result = JSON.parse(stdout || "{}");
    return {
      valid: result.valid !== false,
      errors: result.errors || [],
      warnings: result.warnings || [],
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Unknown error"],
      warnings: [],
    };
  }
}

/**
 * 遮蔽敏感值
 */
function maskSensitiveValues(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;

  const sensitiveKeys = ["apiKey", "apiSecret", "secret", "password", "token", "credential"];
  const result: any = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()));

    if (isSensitive && typeof value === "string") {
      result[key] = value.slice(0, 4) + "***" + (value.length > 8 ? value.slice(-4) : "");
    } else if (typeof value === "object" && value !== null) {
      result[key] = maskSensitiveValues(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
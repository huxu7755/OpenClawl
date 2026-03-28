/**
 * Models 模型管理模块
 * 
 * 功能：
 * 1. 查看已配置的模型
 * 2. 查看模型提供商状态
 * 3. 模型发现
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const MODELS_LOG_PATH = join(RUNTIME_DIR, "models.log");

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
  status: "available" | "unavailable" | "unknown";
}

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  status: "connected" | "disconnected" | "error";
  models: ModelInfo[];
}

export interface ModelsOverview {
  checkedAt: string;
  defaultModel?: string;
  providers: ProviderInfo[];
  summary: {
    providers: number;
    models: number;
    available: number;
    unavailable: number;
  };
}

/**
 * 获取模型概览
 */
export async function getModelsOverview(): Promise<ModelsOverview> {
  const checkedAt = new Date().toISOString();
  const providers: ProviderInfo[] = [];

  // 读取配置文件获取已配置的提供商
  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw/openclaw.json");

  try {
    const configRaw = await readFile(configPath, "utf8");
    const configJson = configRaw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const config = JSON.parse(configJson);

    // 获取默认模型
    const defaultModel = config.agents?.defaults?.model;

    // 解析提供商配置
    if (config.models?.providers) {
      for (const [providerId, providerConfig] of Object.entries(config.models.providers)) {
        const pc = providerConfig as Record<string, any>;
        const models: ModelInfo[] = [];

        if (pc.models && Array.isArray(pc.models)) {
          for (const model of pc.models) {
            models.push({
              id: model.id || model.name,
              name: model.name || model.id,
              provider: providerId,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reasoning: model.reasoning || false,
              vision: model.input?.includes("image") || false,
              status: "available",
            });
          }
        }

        providers.push({
          id: providerId,
          name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
          baseUrl: pc.baseUrl,
          status: pc.apiKey ? "connected" : "disconnected",
          models,
        });
      }
    }
  } catch (error) {
    console.error("[models-insights] failed to read config:", error);
  }

  // 计算统计
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const summary = {
    providers: providers.length,
    models: totalModels,
    available: providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === "available").length, 0),
    unavailable: providers.reduce((sum, p) => sum + p.models.filter((m) => m.status === "unavailable").length, 0),
  };

  const result: ModelsOverview = {
    checkedAt,
    defaultModel: providers.length > 0 ? providers[0].models[0]?.id : undefined,
    providers,
    summary,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(MODELS_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

  return result;
}

/**
 * 发现本地模型 (Ollama 等)
 */
export async function discoverLocalModels(): Promise<{
  provider: string;
  models: ModelInfo[];
  error?: string;
}> {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"], {
      timeout: 10000,
    });

    const lines = stdout.split("\n").slice(1); // 跳过标题行
    const models: ModelInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0]) {
        models.push({
          id: parts[0],
          name: parts[0],
          provider: "ollama",
          status: "available",
        });
      }
    }

    return { provider: "ollama", models };
  } catch (error) {
    return {
      provider: "ollama",
      models: [],
      error: "Ollama 未安装或未运行",
    };
  }
}

/**
 * 测试模型连接
 */
export async function testModelConnection(
  provider: string,
  modelId: string
): Promise<{
  success: boolean;
  responseTime?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    // 使用 openclaw 测试模型
    const { stdout, stderr } = await execFileAsync(
      "openclaw",
      ["agent", "--model", `${provider}/${modelId}`, "--eval", "Say 'OK'"],
      {
        timeout: 30000,
        env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
      }
    );

    const responseTime = Date.now() - startTime;

    return {
      success: stdout.includes("OK") || !stderr,
      responseTime,
    };
  } catch (error) {
    return {
      success: false,
      responseTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 获取模型使用统计
 */
export async function getModelUsage(): Promise<{
  models: { id: string; requests: number; tokens: number }[];
  period: string;
}> {
  // TODO: 从日志或数据库获取使用统计
  return {
    models: [],
    period: "last_24h",
  };
}

/**
 * 读取最近的模型状态记录
 */
export async function readRecentModelsStatus(limit = 10): Promise<ModelsOverview[]> {
  try {
    const raw = await readFile(MODELS_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: ModelsOverview[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ModelsOverview;
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
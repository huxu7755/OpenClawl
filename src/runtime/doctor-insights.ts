/**
 * Doctor 健康检查模块
 * 
 * 功能：
 * 1. 执行 openclaw doctor 检查
 * 2. 解析检查结果
 * 3. 提供快速修复建议
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = join(process.cwd(), "runtime");
const DOCTOR_LOG_PATH = join(RUNTIME_DIR, "doctor.log");

export interface DoctorCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  detail?: string;
  remediation?: string;
  autoFix?: boolean;
}

export interface DoctorResult {
  checkedAt: string;
  overallStatus: "healthy" | "degraded" | "unhealthy";
  checks: DoctorCheck[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failures: number;
    skipped: number;
  };
}

/**
 * 执行 openclaw doctor 检查
 */
export async function runDoctorCheck(): Promise<DoctorResult> {
  const checkedAt = new Date().toISOString();
  const checks: DoctorCheck[] = [];

  try {
    // 尝试执行 openclaw doctor --json
    const { stdout } = await execFileAsync("openclaw", ["doctor", "--json"], {
      timeout: 30000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });

    const parsed = JSON.parse(stdout);
    if (parsed.checks) {
      checks.push(...parsed.checks.map((c: any) => ({
        id: c.id || c.name,
        name: c.name || c.id,
        status: c.status || "skip",
        message: c.message || "",
        detail: c.detail,
        remediation: c.remediation,
        autoFix: c.autoFix ?? false,
      })));
    }
  } catch (error) {
    // 如果 openclaw doctor 不支持 JSON，手动检查
    checks.push(...(await runManualChecks()));
  }

  // 计算统计
  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    failures: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };

  // 确定整体状态
  let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (summary.failures > 0) {
    overallStatus = "unhealthy";
  } else if (summary.warnings > 0) {
    overallStatus = "degraded";
  }

  const result: DoctorResult = {
    checkedAt,
    overallStatus,
    checks,
    summary,
  };

  // 写入日志
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(DOCTOR_LOG_PATH, `${JSON.stringify(result)}\n`, "utf8");

  console.log("[doctor-insights] check completed", {
    overallStatus,
    summary,
  });

  return result;
}

/**
 * 手动执行检查
 */
async function runManualChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Gateway 状态检查
  try {
    const { stdout } = await execFileAsync("openclaw", ["gateway", "status"], {
      timeout: 10000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });
    checks.push({
      id: "gateway-status",
      name: "Gateway 状态",
      status: stdout.includes("Listening") || stdout.includes("live") ? "pass" : "warn",
      message: stdout.includes("Listening") ? "Gateway 正在运行" : "Gateway 状态异常",
      autoFix: false,
    });
  } catch (error) {
    checks.push({
      id: "gateway-status",
      name: "Gateway 状态",
      status: "fail",
      message: "无法检查 Gateway 状态",
      detail: error instanceof Error ? error.message : "Unknown error",
      remediation: "运行 openclaw gateway 启动 Gateway",
      autoFix: true,
    });
  }

  // 2. 配置验证
  try {
    const { stdout } = await execFileAsync("openclaw", ["config", "validate"], {
      timeout: 10000,
    });
    checks.push({
      id: "config-valid",
      name: "配置验证",
      status: stdout.includes("valid") ? "pass" : "warn",
      message: stdout.includes("valid") ? "配置文件有效" : "配置文件有问题",
      autoFix: false,
    });
  } catch (error) {
    checks.push({
      id: "config-valid",
      name: "配置验证",
      status: "fail",
      message: "配置文件验证失败",
      detail: error instanceof Error ? error.message : "Unknown error",
      remediation: "运行 openclaw doctor --fix 修复配置",
      autoFix: true,
    });
  }

  // 3. 频道状态
  try {
    const { stdout } = await execFileAsync("openclaw", ["channels", "status"], {
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });
    const hasChannels = stdout.includes("feishu") || stdout.includes("telegram") || stdout.includes("discord");
    checks.push({
      id: "channels-status",
      name: "频道连接",
      status: hasChannels ? "pass" : "warn",
      message: hasChannels ? "至少有一个频道已连接" : "没有配置频道",
      autoFix: false,
    });
  } catch (error) {
    checks.push({
      id: "channels-status",
      name: "频道连接",
      status: "skip",
      message: "无法检查频道状态",
      autoFix: false,
    });
  }

  // 4. 插件状态
  try {
    const { stdout } = await execFileAsync("openclaw", ["plugins", "list"], {
      timeout: 10000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });
    const hasPlugins = stdout.includes("memory") || stdout.includes("feishu");
    checks.push({
      id: "plugins-status",
      name: "插件状态",
      status: hasPlugins ? "pass" : "warn",
      message: hasPlugins ? "插件已加载" : "没有加载插件",
      autoFix: false,
    });
  } catch (error) {
    checks.push({
      id: "plugins-status",
      name: "插件状态",
      status: "skip",
      message: "无法检查插件状态",
      autoFix: false,
    });
  }

  // 5. 安全检查
  try {
    const { stdout } = await execFileAsync("openclaw", ["security", "audit"], {
      timeout: 15000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });
    const hasIssues = stdout.includes("warn") || stdout.includes("fail") || stdout.includes("critical");
    checks.push({
      id: "security-audit",
      name: "安全审计",
      status: hasIssues ? "warn" : "pass",
      message: hasIssues ? "发现安全问题" : "安全检查通过",
      remediation: hasIssues ? "运行 openclaw security audit --fix 修复安全问题" : undefined,
      autoFix: hasIssues,
    });
  } catch (error) {
    checks.push({
      id: "security-audit",
      name: "安全审计",
      status: "skip",
      message: "无法执行安全审计",
      autoFix: false,
    });
  }

  return checks;
}

/**
 * 执行自动修复
 */
export async function runDoctorFix(): Promise<{ fixed: string[]; failed: string[] }> {
  const fixed: string[] = [];
  const failed: string[] = [];

  try {
    await execFileAsync("openclaw", ["doctor", "--fix"], {
      timeout: 60000,
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || "" },
    });
    fixed.push("doctor --fix executed");
  } catch (error) {
    failed.push(`doctor --fix failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  return { fixed, failed };
}

/**
 * 读取最近的检查记录
 */
export async function readRecentDoctorChecks(limit = 10): Promise<DoctorResult[]> {
  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(DOCTOR_LOG_PATH, "utf8"));
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const results: DoctorResult[] = [];

    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as DoctorResult;
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
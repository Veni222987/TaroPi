// 密钥解析：仅支持配置字面量、环境变量引用（$VAR / ${VAR}）和环境变量兜底。
// 明确不支持 `!command` 动态取密钥，遇到该写法直接报错，不执行任何 shell 命令。

const ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

export interface CredentialOptions {
  provider: string;
  configuredValue?: unknown;
  environmentValue?: string | undefined;
}

/** redactCredential 在错误文本中把密钥替换为 [redacted]，避免日志泄露 */
export function redactCredential(text: string, credential: string | null | undefined): string {
  return credential ? text.split(credential).join("[redacted]") : text;
}

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** hasCredentialSource 判断该 provider 是否配置了任意可用的密钥来源 */
export function hasCredentialSource(options: CredentialOptions): boolean {
  const configured = normalize(options.configuredValue);
  if (configured?.startsWith("!")) {
    throw new Error(`${options.provider} credential uses "!command" syntax, which is not supported; set a literal key or $ENV_VAR reference instead`);
  }
  return configured !== null || normalize(options.environmentValue) !== null;
}

/** resolveCredential 解析密钥：字面量优先，其次 $ENV_VAR 引用，最后环境变量兜底 */
export function resolveCredential(options: CredentialOptions): string | null {
  const configured = normalize(options.configuredValue);
  if (configured?.startsWith("!")) {
    throw new Error(`${options.provider} credential uses "!command" syntax, which is not supported; set a literal key or $ENV_VAR reference instead`);
  }
  if (configured?.startsWith("$")) {
    const match = configured.match(ENV_SOURCE);
    if (!match) throw new Error(`${options.provider} credential has an invalid $ENV_VAR reference: ${configured}`);
    const name = match[1] ?? match[2];
    const value = normalize(process.env[name]);
    if (!value) throw new Error(`${options.provider} credential references empty environment variable: ${name}`);
    return value;
  }
  return configured ?? normalize(options.environmentValue);
}

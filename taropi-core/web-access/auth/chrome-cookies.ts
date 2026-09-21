// 本机 Chromium 系浏览器 Cookie 读取：仅用于显式配置的 authFetch 登录态抓取，默认关闭。
// 复制 Cookies 数据库到临时目录后只读查询，解密后立即清理临时文件；不写入、不修改浏览器数据。
import { execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
  id: string;
  name: string;
  baseDir: string;
  keychainService?: string;
  keychainAccount?: string;
  secretToolApp?: string;
}

const MACOS_BROWSERS: BrowserConfig[] = [
  { id: "chrome", name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "brave", name: "Brave", baseDir: "Library/Application Support/BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
];
const LINUX_BROWSERS: BrowserConfig[] = [
  { id: "chromium", name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
  { id: "chrome", name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

let lastDiagnostic: string | null = null;

/** getLastCookieDiagnostic 返回上一次读取失败的脱敏诊断信息，用于用户提示 */
export function getLastCookieDiagnostic(): string | null {
  return lastDiagnostic;
}

function setDiagnostic(message: string): void {
  lastDiagnostic = message;
}

function browserConfigsForPlatform(): BrowserConfig[] {
  if (process.platform === "darwin") return MACOS_BROWSERS;
  if (process.platform === "linux") return LINUX_BROWSERS;
  return [];
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-w", "-a", account, "-s", service], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

function readLinuxPassword(secretToolApp: string | undefined): Promise<string> {
  if (!secretToolApp) return Promise.resolve("peanuts");
  return new Promise((resolve) => {
    execFile("secret-tool", ["lookup", "application", secretToolApp], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? "peanuts" : stdout.trim() || "peanuts");
    });
  });
}

function runSqlite(dbPath: string, sql: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(new Error(err.code === "ENOENT" ? "sqlite3 CLI not found on PATH" : `sqlite3 query failed: ${err.message}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "[]");
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        reject(new Error("sqlite3 returned invalid JSON"));
      }
    });
  });
}

function decryptCookieValue(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length < 3 || !/^v\d\d$/.test(encrypted.subarray(0, 3).toString("utf8"))) return null;
  const ciphertext = encrypted.subarray(3);
  if (!ciphertext.length) return "";
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(false);
    const unpadded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const padding = unpadded[unpadded.length - 1];
    const stripped = !padding || padding > 16 ? unpadded : unpadded.subarray(0, unpadded.length - padding);
    return new TextDecoder("utf-8", { fatal: true }).decode(stripped);
  } catch {
    return null;
  }
}

function cookieDatabasePath(profilePath: string): string | null {
  const cookies = join(profilePath, "Cookies");
  return existsSync(cookies) ? cookies : null;
}

function listProfiles(basePath: string): string[] {
  if (!existsSync(basePath)) return ["Default"];
  try {
    const profiles = readdirSync(basePath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && cookieDatabasePath(join(basePath, e.name)))
      .map((e) => e.name);
    return profiles.length > 0 ? profiles : ["Default"];
  } catch {
    return ["Default"];
  }
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function domainCookieHosts(host: string): string[] {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return [];
  const candidates = new Set<string>();
  for (let i = 0; i <= parts.length - 2; i++) candidates.add(parts.slice(i).join("."));
  return [...candidates];
}

function buildCookieWhere(hosts: string[]): string {
  const clauses: string[] = [];
  for (const host of hosts) {
    clauses.push(`host_key = '${escapeSqlString(host)}'`);
    for (const candidate of domainCookieHosts(host)) clauses.push(`host_key = '.${escapeSqlString(candidate)}'`);
  }
  return `(${[...new Set(clauses)].join(" OR ")})`;
}

/** getBrowserCookieHeaderForHosts 为指定 host 列表构建 Cookie 请求头；未授权/无匹配数据时返回 null */
export async function getBrowserCookieHeaderForHosts(options: {
  hosts: string[];
  browser?: string;
  profile?: string;
}): Promise<string | null> {
  lastDiagnostic = null;
  const configs = browserConfigsForPlatform();
  const candidates = options.browser ? configs.filter((c) => c.id === options.browser) : configs;
  if (candidates.length === 0) {
    setDiagnostic(options.browser ? `Browser preset '${options.browser}' is not supported on this platform.` : "Chromium cookie extraction is unsupported on this platform.");
    return null;
  }

  for (const config of candidates) {
    const home = homedir();
    const basePath = join(home, config.baseDir);
    const profiles = options.profile ? [options.profile] : listProfiles(basePath);
    for (const profile of profiles) {
      const profilePath = join(basePath, profile);
      const dbPath = cookieDatabasePath(profilePath);
      if (!dbPath) continue;

      const tempDir = mkdtempSync(join(tmpdir(), "taropi-cookies-"));
      try {
        const tempDb = join(tempDir, "Cookies");
        copyFileSync(dbPath, tempDb);

        const password = process.platform === "darwin"
          ? (config.keychainAccount && config.keychainService ? await readKeychainPassword(config.keychainAccount, config.keychainService) : null)
          : await readLinuxPassword(config.secretToolApp);
        if (!password) {
          setDiagnostic(`Could not read ${config.name} cookie encryption password`);
          continue;
        }
        const key = pbkdf2Sync(password, "saltysalt", process.platform === "darwin" ? 1003 : 1, 16, "sha1");

        let rows: Array<Record<string, unknown>>;
        try {
          rows = await runSqlite(tempDb, `SELECT name, host_key, hex(encrypted_value) AS enc FROM cookies WHERE ${buildCookieWhere(options.hosts)}`);
        } catch (err) {
          setDiagnostic(err instanceof Error ? err.message : String(err));
          continue;
        }

        const cookies: CookieMap = {};
        for (const row of rows) {
          const name = typeof row.name === "string" ? row.name : "";
          const encHex = typeof row.enc === "string" ? row.enc : "";
          if (!name || !encHex || !/^[0-9a-f]*$/i.test(encHex)) continue;
          const value = decryptCookieValue(Buffer.from(encHex, "hex"), key);
          if (value !== null && !cookies[name]) cookies[name] = value;
        }
        if (Object.keys(cookies).length === 0) {
          setDiagnostic("No detected Chromium profile contains cookies for the requested host.");
          continue;
        }
        return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
  if (!lastDiagnostic) setDiagnostic("No detected Chromium profile contains a cookie database.");
  return null;
}

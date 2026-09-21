// GitHub 仓库/目录/文件抓取：优先使用 `gh api`（含私有仓库支持），必要时浅克隆到受管理的临时目录。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadWebSearchConfig, resolveGithubCloneConfig } from "../config.ts";
import type { ExtractedContent } from "../types.ts";

const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;
const NON_CODE_SEGMENTS = new Set(["issues", "pull", "pulls", "discussions", "releases", "wiki", "actions", "settings", "security", "projects", "graphs", "compare", "commits", "tags", "branches"]);
const NOISE_DIRS = new Set(["node_modules", "vendor", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"]);
const CLONE_TTL_MS = 15 * 60 * 1000;

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  type: "root" | "blob" | "tree";
}

/** parseGitHubUrl 解析 GitHub 仓库/文件/目录 URL；非 GitHub URL 或不支持的路径返回 null */
export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments: string[] = [];
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
  if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;
  if (segments.length === 2) return { owner, repo, type: "root" };

  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;
  const ref = segments[3];
  if (!ref || ref.length > 1024) return null;
  const path = segments.slice(4).join("/") || undefined;
  return { owner, repo, ref, path, type: action };
}

function ghAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile("gh", ["--version"], { timeout: 5000 }, (err) => resolve(!err)));
}

function ghApi(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["api", ...args], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function fetchViaApi(url: string, owner: string, repo: string, info: GitHubUrlInfo): Promise<ExtractedContent | null> {
  const ref = info.ref ?? (await ghApi([`repos/${owner}/${repo}`, "--jq", ".default_branch"]));
  if (!ref) return null;

  if (info.type === "blob" && info.path) {
    const content = await ghApi([`repos/${owner}/${repo}/contents/${info.path}?ref=${ref}`, "--jq", ".content"]);
    if (!content) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(content, "base64").toString("utf-8");
    } catch {
      return null;
    }
    const truncated = decoded.length > MAX_INLINE_FILE_CHARS;
    const body = truncated ? `${decoded.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at 100K chars]` : decoded;
    return { url, title: `${owner}/${repo} - ${info.path}`, content: `## ${info.path}\n${body}`, error: null };
  }

  const [treeRaw, readmeRaw] = await Promise.all([
    ghApi([`repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"]),
    ghApi([`repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"]),
  ]);
  if (!treeRaw && !readmeRaw) return null;

  const lines: string[] = [];
  if (treeRaw) {
    const paths = treeRaw.split("\n").filter(Boolean);
    const truncated = paths.length > MAX_TREE_ENTRIES;
    lines.push("## Structure", paths.slice(0, MAX_TREE_ENTRIES).join("\n") + (truncated ? `\n... (${paths.length} total entries)` : ""), "");
  }
  if (readmeRaw) {
    try {
      lines.push("## README.md", Buffer.from(readmeRaw, "base64").toString("utf-8").slice(0, 8192), "");
    } catch {
      // ignore decode failure, tree info is still useful
    }
  }
  return { url, title: info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`, content: lines.join("\n"), error: null };
}

function cloneKey(owner: string, repo: string, ref?: string): string {
  return `${owner}__${repo}__${ref ?? "default"}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function execGitClone(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal,
    }, (err) => resolve(!err));
  });
}

function pruneStaleClones(clonePath: string): void {
  if (!existsSync(clonePath)) return;
  const now = Date.now();
  try {
    for (const entry of readdirSync(clonePath)) {
      const path = join(clonePath, entry);
      try {
        const stat = statSync(path);
        if (stat.isDirectory() && now - stat.mtimeMs > CLONE_TTL_MS) rmSync(path, { recursive: true, force: true });
      } catch {
        // 忽略并发清理错误
      }
    }
  } catch {
    // 忽略目录读取错误
  }
}

async function cloneRepo(owner: string, repo: string, ref: string | undefined, signal?: AbortSignal): Promise<string | null> {
  const config = resolveGithubCloneConfig(loadWebSearchConfig());
  if (!config.enabled) return null;
  mkdirSync(config.clonePath, { recursive: true });
  pruneStaleClones(config.clonePath);

  const destination = join(config.clonePath, cloneKey(owner, repo, ref));
  if (existsSync(destination)) {
    try {
      statSync(join(destination, ".git"));
      return destination;
    } catch {
      rmSync(destination, { recursive: true, force: true });
    }
  }

  const url = `https://github.com/${owner}/${repo}.git`;
  const timeoutMs = config.cloneTimeoutSeconds * 1000;
  const args = ref
    ? ["clone", "--depth", "1", "--branch", ref, "--single-branch", url, destination]
    : ["clone", "--depth", "1", url, destination];
  const ok = await execGitClone(args, tmpdir(), timeoutMs, signal);
  if (!ok) {
    rmSync(destination, { recursive: true, force: true });
    return null;
  }
  return destination;
}

async function buildTreeListing(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (results.length >= MAX_TREE_ENTRIES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= MAX_TREE_ENTRIES) return;
      if (entry.isDirectory()) {
        if (NOISE_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else {
        results.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return results;
}

async function extractFromClone(url: string, owner: string, repo: string, info: GitHubUrlInfo, localPath: string): Promise<ExtractedContent> {
  if (info.type === "blob" && info.path) {
    const filePath = join(localPath, info.path);
    try {
      const content = await readFile(filePath, "utf-8");
      const truncated = content.length > MAX_INLINE_FILE_CHARS;
      const body = truncated ? `${content.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at 100K chars]` : content;
      return { url, title: `${owner}/${repo} - ${info.path}`, content: `## ${info.path}\n${body}`, error: null };
    } catch (err) {
      return { url, title: "", content: "", error: `Failed to read cloned file: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const paths = await buildTreeListing(localPath);
  const lines = ["## Structure", paths.join("\n"), "", `Cloned to: ${localPath}`, "Use read/bash for deeper exploration."];
  return { url, title: info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`, content: lines.join("\n"), error: null };
}

/** extractGitHub 抓取 GitHub 仓库内容：优先 `gh api`，不可用或大仓库时浅克隆到受限临时目录 */
export async function extractGitHub(url: string, signal?: AbortSignal, forceClone?: boolean): Promise<ExtractedContent | null> {
  const info = parseGitHubUrl(url);
  if (!info) return null;
  const { owner, repo } = info;

  if (!forceClone && (await ghAvailable())) {
    try {
      const result = await fetchViaApi(url, owner, repo, info);
      if (result) return result;
    } catch {
      // API 视图失败时回退到克隆
    }
  }

  const localPath = await cloneRepo(owner, repo, info.ref, signal);
  if (!localPath) {
    return { url, title: "", content: "", error: `Could not access ${owner}/${repo}. Install \`gh\` CLI for API access, or ensure \`git\` is available for cloning.` };
  }
  return extractFromClone(url, owner, repo, info, localPath);
}

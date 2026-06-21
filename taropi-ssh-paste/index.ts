import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import {
  writeFileSync, unlinkSync, mkdtempSync, rmdirSync,
  readFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════
//  剪贴板读取 (参考 Claudeboard 跨平台实现)
// ═══════════════════════════════════════════════════════════

const enum Platform { MacOS, Linux, Windows }

function detectPlatform(): Platform | null {
  switch (process.platform) {
    case "darwin": return Platform.MacOS;
    case "linux": return Platform.Linux;
    case "win32": return Platform.Windows;
    default: return null;
  }
}

async function readClipboardImage(platform: Platform): Promise<{ buffer: Buffer; format: string } | null> {
  switch (platform) {
    case Platform.MacOS: return readClipboardMacOS();
    case Platform.Linux: return readClipboardLinux();
    case Platform.Windows: return readClipboardWindows();
    default: return null;
  }
}

async function readClipboardMacOS(): Promise<{ buffer: Buffer; format: string } | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-clipboard-"));
  const tmpFile = join(tmpDir, "clipboard.png");
  try {
    const script = `
set tmpFile to POSIX file "${tmpFile}"
set f to open for access tmpFile with write permission
set eof f to 0
write (the clipboard as «class PNGf») to f
close access f
`;
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      stdio: "pipe", timeout: 10000,
    });
    if (!existsSync(tmpFile)) return null;
    const buffer = readFileSync(tmpFile);
    return buffer.length > 0 ? { buffer, format: "png" } : null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpFile); rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

async function readClipboardLinux(): Promise<{ buffer: Buffer; format: string } | null> {
  for (const cmd of ["xclip -selection clipboard -t image/png -o", "wl-paste -t image/png"]) {
    try {
      const buf = execSync(cmd, { stdio: "pipe", timeout: 10000, encoding: "buffer" }) as Buffer;
      if (buf.length > 0) return { buffer: buf, format: "png" };
    } catch { /* 尝试下一条命令 */ }
  }
  return null;
}

async function readClipboardWindows(): Promise<{ buffer: Buffer; format: string } | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-clipboard-"));
  const tmpFile = join(tmpDir, "clipboard.png");
  try {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $img.Save("${tmpFile.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "ok"
} else { Write-Host "no" }
`;
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, {
      stdio: "pipe", timeout: 10000,
    }).toString().trim();
    if (out !== "ok" || !existsSync(tmpFile)) return null;
    const buffer = readFileSync(tmpFile);
    return buffer.length > 0 ? { buffer, format: "png" } : null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpFile); rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════
//  SSH 连接检测
// ═══════════════════════════════════════════════════════════

interface SshConnection {
  target: string;
  cmdline: string;
}

function detectSshConnections(): SshConnection[] {
  try {
    const out = execSync(
      "ps -eo pid,command --no-headers 2>/dev/null || ps -eo pid,args",
      { stdio: "pipe", timeout: 3000 },
    ).toString();

    const seen = new Set<string>();
    const conns: SshConnection[] = [];

    for (const line of out.split("\n")) {
      if (line.includes("grep") || line.includes("sshd")) continue;

      const m = line.match(/^\s*\d+\s+(.*)$/);
      if (!m) continue;
      const cmd = m[1].trim();

      if (!cmd.match(/(?:^|\s|\/)ssh(?:\s|$)/)) continue;
      if (cmd.includes("ssh-agent") || cmd.includes("ssh-add") || cmd.includes("ssh-keyscan")) continue;

      const parts = cmd.split(/\s+/);
      let target = "";

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p.startsWith("-")) {
          if (!p.startsWith("--") && p.length === 2 && i + 1 < parts.length) i++;
          continue;
        }
        if (p === "ssh") continue;
        if (p.includes("@")) { target = p; break; }
        if (!target && !p.startsWith("-")) target = p;
        if (target) break;
      }

      if (target && !seen.has(target)) {
        seen.add(target);
        conns.push({ target, cmdline: cmd.slice(0, 80) });
      }
    }
    return conns;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
//  上传
// ═══════════════════════════════════════════════════════════

function uploadBufferToRemote(
  buffer: Buffer,
  format: string,
  target: string,
): string {
  const remoteDir = ".pi/images";
  const ext = format === "jpeg" ? "jpg" : format;
  const filename = `${randomUUID()}.${ext}`;
  const remotePath = `${remoteDir}/${filename}`;

  execSync(`ssh ${target} "mkdir -p ${remoteDir}"`, {
    stdio: "pipe", timeout: 5000,
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "pi-ssh-paste-"));
  const localFile = join(tmpDir, filename);
  try {
    writeFileSync(localFile, buffer);
    execSync(`scp -q ${localFile} ${target}:${remotePath}`, {
      stdio: "pipe", timeout: 30000,
    });
  } finally {
    try { unlinkSync(localFile); rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  return remotePath;
}

// ═══════════════════════════════════════════════════════════
//  扩展主体
// ═══════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  const platform = detectPlatform();
  if (platform === null) return;

  pi.registerShortcut("ctrl+shift+v", {
    description: "SSH 图片粘贴: 上传剪贴板图片到 SSH 远端",
    async handler(ctx) {
      const img = await readClipboardImage(platform);
      if (!img) {
        ctx.ui.notify("[ssh-paste] 剪贴板中没有图片", "warning");
        return;
      }

      const conns = detectSshConnections();
      if (conns.length === 0) {
        ctx.ui.notify("[ssh-paste] 未检测到活跃的 SSH 连接，请先 ssh 到远端", "warning");
        return;
      }

      let target: string;
      if (conns.length === 1) {
        target = conns[0].target;
      } else {
        const choice = await ctx.ui.select(
          "选择上传目标",
          conns.map((c) => c.target),
        );
        if (!choice) return;
        target = choice;
      }

      let remotePath: string;
      try {
        remotePath = uploadBufferToRemote(img.buffer, img.format, target);
      } catch (err: any) {
        const msg = (err.stderr?.toString() || err.message).slice(0, 200);
        ctx.ui.notify(`[ssh-paste] 上传失败: ${msg}`, "error");
        return;
      }

      ctx.ui.notify(`[ssh-paste] 已上传 → ${target}:${remotePath}`, "success");

      // 粘贴到 TUI 输入框
      const ui = ctx.ui as any;
      if (typeof ui.setEditorText === "function") {
        ui.setEditorText(remotePath);
      } else {
        execSync(
          `printf '%s' "${remotePath}" | pbcopy 2>/dev/null || ` +
          `printf '%s' "${remotePath}" | xclip -selection clipboard 2>/dev/null || ` +
          `echo -n "${remotePath}" | clip.exe 2>/dev/null`,
          { stdio: "pipe" },
        );
        ctx.ui.notify("[ssh-paste] 路径已复制到剪贴板，Ctrl+V 粘贴到输入框", "info");
      }
    },
  });
}

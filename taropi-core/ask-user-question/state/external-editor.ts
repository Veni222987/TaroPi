import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTui {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

function runEditor(command: string, file: string): Promise<void> {
	const [editor, ...args] = command.split(" ");
	if (!editor) return Promise.reject(new Error("外部编辑器命令为空"));

	return new Promise((resolve, reject) => {
		const child = spawn(editor, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
			reject(new Error(`外部编辑器异常退出（${reason}）`));
		});
	});
}

export async function editWithExternalEditor(tui: ExternalEditorTui, command: string, value: string): Promise<string> {
	const tempDir = mkdtempSync(join(tmpdir(), "taropi-ask-user-question-"));
	const tempFile = join(tempDir, "answer.md");
	let tuiStopped = false;

	try {
		writeFileSync(tempFile, value, "utf8");
		tui.stop();
		tuiStopped = true;
		process.stdout.write(`正在启动外部编辑器：${command}\n编辑器关闭后将自动返回 Pi。\n`);
		await runEditor(command, tempFile);
		return readFileSync(tempFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// 临时目录清理尽力而为，不影响 TUI 恢复。
		}
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}

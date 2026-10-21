import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { loadPlanConfig } from "./config.ts";
import { createPlanFile, findActivePlan, hasPlanSteps, publishPlanFile, savePlanFile } from "./file.ts";
import { phaseMessage } from "./prompts.ts";
import { switchPlanModel } from "./runtime.ts";
import { generatePlanTitle } from "./title.ts";
import { showPlanDecision } from "./tui.ts";
import type { PlanConfig, PlanRequest, PlanResult, PlanStatus, WorkflowState } from "./types.ts";

// PlanWorkflow 管理会话检查点及一次性阶段启动，不接管每轮模型上下文。
export class PlanWorkflow {
	state: WorkflowState = idleState();
	config: PlanConfig = loadPlanConfig();
	private generation = 0;
	private autoLaunch = false;
	private launchCancelled = false;
	private launching = false;
	private launchMessage: string | undefined;
	private entering: AbortController | undefined;

	constructor(private readonly pi: ExtensionAPI, private readonly render: () => void) {}

	// restore 从当前会话的 Markdown 恢复阶段，只提示而不发请求。
	restore(ctx: ExtensionContext): void {
		this.invalidate();
		this.config = loadPlanConfig();
		const document = findActivePlan(ctx.cwd, ctx.sessionManager.getSessionId());
		this.state = document ? {
			phase: document.file.metadata.status === "implementing" ? "implementing" : "planning",
			task: document.file.metadata.task, planText: document.planText, planFile: document.file,
			adjustmentRounds: document.file.metadata.adjustmentRounds, pendingLaunch: document.file.metadata.pendingLaunch,
		} : idleState();
		this.render();
		if (document) ctx.ui.notify(`已恢复 plan：${this.state.phase === "planning" ? "计划中" : "实施中"}，输入任意内容继续`, "info");
	}

	// invalidate 使会话退出、切换或新输入前的异步回调失效，磁盘检查点不清空。
	invalidate(): void {
		this.generation++;
		this.entering?.abort();
		this.entering = undefined;
		this.autoLaunch = false;
		this.launching = false;
		this.launchMessage = undefined;
	}

	// enter 仅供用户 /plan 调用，标题生成与首次排他创建成功后才进入 planning。
	async enter(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!task.trim()) { ctx.ui.notify("用法: /plan 任务描述", "info"); return; }
		if (this.entering) { ctx.ui.notify("正在创建 plan，请等待或取消创建", "warning"); return; }
		if (this.state.phase !== "idle") { ctx.ui.notify("已有活动 plan，可输入补充继续或说“退出 plan”", "warning"); return; }
		const generation = this.generation;
		const controller = new AbortController();
		this.entering = controller;
		try {
			await ctx.waitForIdle();
			if (generation !== this.generation || controller.signal.aborted) return;
			this.config = loadPlanConfig();
			const title = await generatePlanTitle(task.trim(), ctx, this.config.planning.model, controller.signal);
			if (generation !== this.generation || controller.signal.aborted) return;
			if (!title) { ctx.ui.notify("计划创建已取消，仍为非 plan 状态", "info"); return; }
			const file = createPlanFile(ctx.cwd, ctx.sessionManager.getSessionId(), task.trim(), new Date(), title);
			const published = publishPlanFile(file);
			if (published !== "created") {
				ctx.ui.notify(published === "exists" ? "同一分钟同名计划已存在，请更换任务名称或下一分钟重试"
					: "计划文件创建失败，未进入 plan；请检查目录权限及文件系统是否支持排他发布", "warning");
				return;
			}
			this.state = { ...idleState(), phase: "planning", task: task.trim(), planFile: file };
			this.entering = undefined;
			this.render();
			await switchPlanModel(this.pi, ctx, this.config.planning.model);
			if (generation !== this.generation) return;
			this.pi.sendUserMessage(phaseMessage(this.state, this.config), { deliverAs: "followUp" });
		} catch (error) {
			if (generation === this.generation && !controller.signal.aborted) ctx.ui.notify(`计划创建未完成：${String(error)}`, "warning");
		} finally {
			if (this.entering === controller) this.entering = undefined;
		}
	}

	// dispatch 执行模型请求的合法流转，确认必须来自 UI，终态保留历史 Markdown。
	async dispatch(request: PlanRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<PlanResult> {
		if (request.action === "status") return { text: phaseMessage(this.state, this.config) };
		if (this.state.phase === "idle") throw new Error("只有用户执行 /plan 才能进入计划流程");
		if (signal?.aborted) return { text: "计划操作已取消，检查点保持不变；等待用户输入。", terminate: true };
		if (request.action === "submit") return this.submit(request.text ?? "", ctx, signal);
		if (request.action === "complete" && (this.state.phase !== "implementing" || this.state.pendingLaunch)) {
			throw new Error("只有已启动的实施阶段可以完成");
		}
		if (request.action === "complete" && !request.text?.trim()) throw new Error("complete 需要结果、验证和风险摘要");
		const status = request.action === "complete" ? "completed" : "exited";
		this.state.pendingLaunch = false;
		this.save(ctx, status, request.text);
		this.invalidate();
		this.state = idleState();
		this.render();
		return { text: [phaseMessage(this.state, this.config), request.text].filter(Boolean).join("\n\n") };
	}

	// blockReason 应用独立阶段工具策略；实施提示送达前继续使用计划阶段策略。
	blockReason(toolName: string): string | undefined {
		const phase = this.state.pendingLaunch ? "planning" : this.state.phase;
		if (!this.config[phase].blockedTools.includes(toolName)) return undefined;
		return phase === "planning" ? `计划阶段禁止 ${toolName}；其他工具和 shell 仅可读，禁止实际修改数据。`
			: `${phase} 阶段配置禁止 ${toolName}`;
	}

	// settled 在确认后的正常收尾处触发压缩，回调启动实施；不返回边界续跑指令。
	settled(ctx: ExtensionContext, aborted: boolean): void {
		if (!this.autoLaunch || !this.state.pendingLaunch) return;
		this.autoLaunch = false;
		if (aborted) return;
		this.launching = true;
		this.launchCancelled = false;
		const generation = this.generation;
		const ready = (): void => {
			void this.launch(ctx, generation).catch((error: unknown) => {
				if (generation !== this.generation) return;
				this.launching = false;
				ctx.ui.notify(`实施尚未启动，输入任意内容重试：${String(error)}`, "warning");
			});
		};
		ctx.compact({
			onComplete: ready,
			onError: (error) => {
				if (generation !== this.generation) return;
				if (this.launchCancelled) { this.launching = false; return; }
				ctx.ui.notify(`计划上下文压缩失败，将直接开始实施：${error.message}`, "warning");
				ready();
			},
		});
	}

	// compactFailed 记录用户取消压缩，避免取消后仍自动执行。
	compactFailed(aborted: boolean): void {
		if (this.launching && aborted) this.launchCancelled = true;
	}

	// input 仅在待启动检查点补发一次实施提示；普通输入不改写或追加规则。
	async input(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | undefined> {
		if (this.entering && event.source !== "extension") this.invalidate();
		if (!this.state.pendingLaunch) return undefined;
		if (event.source === "extension" && event.text === this.launchMessage) {
			this.state.pendingLaunch = false;
			this.launching = false;
			this.launchMessage = undefined;
			this.save(ctx);
			return undefined;
		}
		if (event.source === "extension") return undefined;
		// 新输入接管恢复，旧压缩或切换回调不得再次发送实施提示。
		this.invalidate();
		const generation = this.generation;
		await switchPlanModel(this.pi, ctx, this.config.implementing.model);
		if (generation !== this.generation) return { action: "handled" };
		this.state.pendingLaunch = false;
		const text = `${phaseMessage(this.state, this.config)}\n\n用户输入：\n${event.text}`;
		this.save(ctx);
		return { action: "transform", text, images: event.images };
	}

	private async submit(text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<PlanResult> {
		if (this.state.phase !== "planning") throw new Error("只有计划阶段可以 submit");
		if (!hasPlanSteps(text)) throw new Error("submit 需要包含编号步骤的完整计划");
		this.state.planText = text.trim();
		this.save(ctx);
		const generation = this.generation;
		const decision = await showPlanDecision(ctx, this.state.planFile, signal);
		if (generation !== this.generation) return { text: "确认已失效，原检查点保持不变；不处理旧会话决策。", terminate: true };
		if (!signal?.aborted && decision === "execute") {
			this.state.phase = "implementing";
			this.state.pendingLaunch = true;
			this.autoLaunch = true;
			this.save(ctx);
			return { text: "用户已确认。等待本轮结束后压缩上下文、切换实施模型并下发实施规则；不要提前写入。", terminate: true };
		}
		const supplement = !signal?.aborted && decision === "supplement";
		if (supplement) {
			this.state.adjustmentRounds++;
			this.save(ctx);
		}
		const message = supplement ? "仍在计划中，请在主输入框补充内容，发送后继续修订计划。"
			: "确认已取消，仍在计划中；等待用户输入继续，只有明确要求退出才结束 plan。";
		ctx.ui.notify(message, "info");
		// terminate 仅在整批结果都同意时生效；中断运行还会阻止排队续跑，并由 TUI 恢复排队草稿。
		ctx.abort();
		return { text: message, terminate: true };
	}

	private async launch(ctx: ExtensionContext, generation: number): Promise<void> {
		if (generation !== this.generation || !this.state.pendingLaunch || this.launchCancelled) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) { this.launching = false; return; }
		await switchPlanModel(this.pi, ctx, this.config.implementing.model);
		if (generation !== this.generation || !this.state.pendingLaunch || this.launchCancelled) return;
		const next = { ...this.state, pendingLaunch: false };
		this.launchMessage = phaseMessage(next, this.config);
		this.pi.sendUserMessage(this.launchMessage, { deliverAs: "followUp" });
	}

	private save(ctx: ExtensionContext, status: PlanStatus = this.state.phase === "implementing" ? "implementing" : "planning", result?: string): void {
		if (!savePlanFile(this.state, status, result)) ctx.ui.notify("计划文件未能持久化，内存状态仍可用；重启可能恢复旧检查点", "warning");
		this.render();
	}
}

function idleState(): WorkflowState {
	return { phase: "idle", task: "", planText: "", adjustmentRounds: 0, pendingLaunch: false };
}

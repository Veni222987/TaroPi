import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.ts";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.ts";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.ts";
import { displayLabel, t } from "./state/i18n-bridge.ts";
import { sentinelsToAppend } from "./state/row-intent.ts";
import { normalizeQuestionParams, type RawQuestionParams } from "./tool/normalize-params.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.ts";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean): void {
	const payload: AskUserBlockedEventPayload = { active };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams) {
	emitAskUserBlockedEvent(pi, true);
	try {
		emitTerminalAttention();
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ui, typed), typed);
	} finally {
		emitAskUserBlockedEvent(pi, false);
	}
}

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "错误：当前处于非交互模式，无法展示提问界面。";

const ERROR_NO_CUSTOM_UI =
	"错误：当前客户端无法渲染交互式提问界面（自定义 UI 不可用）。用户并未看到这些问题——请不要将其视为用户拒绝，直接以纯文本在对话中向用户提问。";

const ERROR_SESSION_LOAD_FAILED =
	"错误：提问界面加载失败（可能是运行期间磁盘依赖被变更）。用户并未看到这些问题——请不要将其视为用户拒绝，直接以纯文本在对话中提问，并提醒用户必要时修复依赖并重启 Pi。";

const ERROR_STALE_MODULE_CACHE =
	"错误：提问界面因先前的模块缓存失效无法加载。用户并未看到这些问题——请不要将其视为用户拒绝，直接以纯文本在对话中提问，并提醒用户重启 Pi 以恢复该工具。";

export const BEL = "\x07";

function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// 终端提醒失败不影响正常提问流程。
	}
}

export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.ts");
type SessionRef = { current: import("./state/questionnaire-session.ts").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.ts");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED}（原因：${cause}）` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE}（模块导出键：${keys}）`,
		};
	}
	return { ok: true, module: mod };
}

function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`提问窗口已隐藏 — 按 ${formatKeySpecForDisplay(collapseKey)} 重新展开`, "info");
		}
		return { consume: true };
	});
}

function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	sessionRef: SessionRef;
	Session: SessionModule["QuestionnaireSession"];
}) {
	const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, Session } = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.ts").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.ts").QuestionnaireSessionComponent => {
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done,
			keybindings,
			editInput: async (value) => {
				try {
					const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
						import("@earendil-works/pi-coding-agent"),
						import("./state/external-editor.ts"),
					]);
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("未配置外部编辑器命令");
					return await editWithExternalEditor(tui, editorCommand, value);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${t("editor.failed", "外部编辑器启动失败")}：${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
		});
		sessionRef.current = session;
		return session.component;
	};
}

async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams) {
	if (hasDialogUI(ctx.ui)) {
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
	}
	return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
}

function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `需求不明确时，向用户提出最多 ${MAX_QUESTIONS} 个结构化问题（每题 ${MIN_OPTIONS}-${MAX_OPTIONS} 个选项）`;

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`当用户需求存在歧义、缺少关键决策且无法自行合理推断时，使用 ask_user_question 向用户澄清；单次调用最多可同时提出 ${MAX_QUESTIONS} 个问题。`,
	`每个问题必须提供 ${MIN_OPTIONS}-${MAX_OPTIONS} 个选项，使用一维字符串数组 options，每项采用 "选项名称 — 选项说明" 格式（名称简短明了，说明解释含义或取舍）。系统会自动在每题末尾追加"输入内容"自定义行，用户也可按 Esc 取消，切勿自行编写"其他"、"输入内容"或"Other"等保留选项。`,
	`若允许选择多项，请设置 multiSelect: true。当单选选项需要对比代码片段、布局草图、架构图或配置示例时，可提供与 options 按索引一一对应的 previews 字符串数组（Markdown 文本，仅单选生效）。如果有明确推荐方案，请将其放在第 1 项并在选项名称末尾加上"（推荐）"。`,
	"不要连续多次调用 ask_user_question——请将所有需要澄清的问题汇总在一次调用中提出。",
];

export const DEFAULT_TOOL_DESCRIPTION = `在执行过程中向用户提出一个或多个结构化问题，用于：
1. 收集用户的偏好与具体需求
2. 澄清存在歧义的指令
3. 在实现过程中让用户决定技术方案或取舍
4. 给出清晰选项让用户确认下一步方向

使用说明：
- options 是一维字符串数组（2-4 项），推荐格式为 "选项名称 — 选项说明"。系统会自动在每题末尾追加"输入内容"自定义回答行，用户也可按 Esc 退出提问；切勿自行添加"其他"、"输入内容"或"Other"等保留项（运行时会拒绝）。
- 选项不互斥时设置 multiSelect: true。
- 若有推荐选项，请将其排在第一位，并在选项名称末尾标注"（推荐）"。

预览功能（previews）：
- 当选项涉及需要直观对比的内容（如 UI ASCII 草图、代码片段、架构/流程图、配置示例）时，可提供可选的 previews 字符串数组，按索引与 options 一一对应，内容为 Markdown 文本。
- 当任一选项包含预览内容时，终端界面会自动切换为左右分栏预览（窄屏自动上下堆叠）；输入自定义内容时自动展开为全宽。简单偏好问题无需使用预览；previews 仅支持单选（multiSelect 为 true 时不显示预览）。`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "向用户提问",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = normalizeQuestionParams(params as unknown as RawQuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			emitAskUserPromptEvent(pi, typed);

			if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
				return runRpcPath(pi, ctx.ui, typed);
			}

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			const sessionLoad = await loadQuestionnaireSession();
			if (!sessionLoad.ok) {
				return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
			}
			const { QuestionnaireSession } = sessionLoad.module;
			const collapseKey = resolveCollapseKey(loadConfig());

			const sessionRef: SessionRef = { current: null };
			const overlayHandleRef: OverlayHandleRef = { current: undefined };
			const removeOverlayInputListener = registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef);
			const canReopenWhileHidden = removeOverlayInputListener !== undefined;

			emitAskUserBlockedEvent(pi, true);
			try {
				emitTerminalAttention();
				const result = await ctx.ui.custom<QuestionnaireResult>(
					makeSessionFactory({
						ctx,
						typed,
						itemsByTab,
						collapseKey,
						canReopenWhileHidden,
						sessionRef,
						Session: QuestionnaireSession,
					}),
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							overlayHandleRef.current = handle;
							sessionRef.current?.setOverlayHandle(handle);
						},
					},
				);

				if (result === undefined) {
					return resolveUndefinedResult(ctx, typed);
				}

				return buildQuestionnaireResponse(result, typed);
			} finally {
				removeOverlayInputListener?.();
				emitAskUserBlockedEvent(pi, false);
			}
		},
	});

	prewarmSessionGraph();
}

export { buildQuestionnaireResponse, buildToolResult };

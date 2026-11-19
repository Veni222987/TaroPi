import { type Static, Type } from "typebox";
import { LABELS_BY_KIND, ROW_INTENT_META } from "../state/row-intent.ts";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

// 保留标签清单：涵盖中文与英文常见占位词，防止模型自行添加与运行时行冲突的选项。
export const RESERVED_LABELS = [
	"其他",
	"其它",
	ROW_INTENT_META.other.label,
	ROW_INTENT_META.next.label,
	"Other",
	"Type something.",
	"Next",
] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

// 两层对象嵌套的工具参数 Schema（第 1 层为根对象，第 2 层为单个问题对象），
// 选项与可选预览使用一维字符串数组，避免 Gemini 系列模型在三层嵌套对象时序列化失败。
export const QuestionInputSchema = Type.Object({
	question: Type.String({
		description:
			'要向用户提出的完整问题，需清晰具体并以问号结尾。例如："日期格式化希望使用哪个库？"若 multiSelect 为 true，请按多选语境表述。',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `最多 ${MAX_HEADER_LENGTH} 个字符（超出将被拒绝）。显示在问题旁边的简短标签，例如："认证方式"、"库选择"、"方案"。`,
	}),
	options: Type.Array(
		Type.String({
			description:
				'选项文本，推荐格式为 "选项名称 — 选项说明"（名称简短，最多 60 字；说明解释含义或取舍）。不要自行添加"其他"或"输入内容"选项。',
		}),
		{
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description:
				'该问题的可选项列表，必须提供 2-4 项，每项为 "选项名称 — 选项说明" 格式的字符串。系统会自动追加"输入内容"自定义行，切勿手动编写。',
		},
	),
	previews: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_OPTIONS,
			description:
				"可选，与 options 按索引一一对应的 Markdown 预览内容（例如代码片段、ASCII 布局草图、配置示例），仅单选生效。不需要预览的选项可传空字符串。",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "设为 true 时允许用户多选。适用于选项之间不互斥的场景。",
		}),
	),
});

export const QuestionsInputSchema = Type.Array(QuestionInputSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "要向用户提出的问题列表（1-4 个问题）。",
});

export const QuestionParamsSchema = Type.Object({
	questions: QuestionsInputSchema,
});

export type QuestionInput = Static<typeof QuestionInputSchema>;
export type QuestionInputParams = Static<typeof QuestionParamsSchema>;

// 归一化后的内部数据结构，供状态机、TUI（含 PreviewPane）与 RPC 降级共用。
export interface OptionData {
	label: string;
	description: string;
	preview?: string;
}

export interface QuestionData {
	question: string;
	header: string;
	options: OptionData[];
	multiSelect?: boolean;
}

export interface QuestionParams {
	questions: QuestionData[];
}

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_custom_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "session_load_failed"
	| "stale_module_cache";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	globalNote?: string;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}

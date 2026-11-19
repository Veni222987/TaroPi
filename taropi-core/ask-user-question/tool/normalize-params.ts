import type { OptionData, QuestionData, QuestionInput, QuestionInputParams, QuestionParams } from "./types.ts";

// 清理模型参数中偶发的裸回车符（\r），保留真实换行（\r\n -> \n）。
export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

// 兼容分隔符优先级：带空格破折号 > 全角破折号 > 带空格连字符 > 中文冒号 > 英文冒号空格 > 换行。
const OPTION_SEPARATORS = [" — ", " -- ", " - ", "—", "：", ": "] as const;

// parseOptionString 将 "选项名称 — 选项说明" 拆分为 { label, description }。
export function parseOptionString(raw: string): { label: string; description: string } {
	const cleaned = normalizeLineTerminators(raw).trim();
	if (!cleaned) return { label: "", description: "" };

	const newlineIdx = cleaned.indexOf("\n");
	const firstLine = newlineIdx >= 0 ? cleaned.slice(0, newlineIdx).trim() : cleaned;
	const restLines = newlineIdx >= 0 ? cleaned.slice(newlineIdx + 1).trim() : "";

	for (const sep of OPTION_SEPARATORS) {
		const idx = firstLine.indexOf(sep);
		if (idx > 0) {
			const label = firstLine.slice(0, idx).trim();
			const inlineDesc = firstLine.slice(idx + sep.length).trim();
			const description = restLines ? (inlineDesc ? `${inlineDesc}\n${restLines}` : restLines) : inlineDesc;
			return { label, description };
		}
	}

	if (newlineIdx > 0) {
		return { label: firstLine, description: restLines };
	}

	return { label: cleaned, description: "" };
}

type RawOptionInput = string | OptionData;
type RawQuestionInput = Omit<QuestionInput, "options"> & {
	options: RawOptionInput[];
	previews?: string[];
};
export type RawQuestionParams = {
	questions: RawQuestionInput[];
};

function normalizeOption(rawOption: RawOptionInput, previewCandidate: unknown): OptionData {
	const rawPreview =
		typeof previewCandidate === "string"
			? normalizeLineTerminators(previewCandidate)
			: typeof rawOption === "object" && rawOption !== null && typeof rawOption.preview === "string"
				? normalizeLineTerminators(rawOption.preview)
				: undefined;

	const preview = rawPreview && rawPreview.length > 0 ? rawPreview : undefined;

	if (typeof rawOption === "string") {
		const { label, description } = parseOptionString(rawOption);
		return {
			label,
			description,
			...(preview !== undefined ? { preview } : {}),
		};
	}

	return {
		label: normalizeLineTerminators(rawOption.label).trim(),
		description: normalizeLineTerminators(rawOption.description ?? "").trim(),
		...(preview !== undefined ? { preview } : {}),
	};
}

// normalizeQuestionParams 将工具两层入参（options: string[], previews?: string[]）归一化为内部结构。
export function normalizeQuestionParams(params: QuestionInputParams | QuestionParams | RawQuestionParams): QuestionParams {
	return {
		questions: params.questions.map((q): QuestionData => {
			const previews = "previews" in q && Array.isArray(q.previews) ? q.previews : undefined;
			const normalized: QuestionData = {
				question: normalizeLineTerminators(q.question),
				header: normalizeLineTerminators(q.header),
				options: q.options.map((opt, idx) => normalizeOption(opt, previews?.[idx])),
			};
			if (q.multiSelect !== undefined) {
				normalized.multiSelect = q.multiSelect;
			}
			return normalized;
		}),
	};
}

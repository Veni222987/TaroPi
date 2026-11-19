import { MAX_QUESTIONS, MIN_OPTIONS, type QuestionnaireError, type QuestionParams, RESERVED_LABELS } from "./types.ts";

export const ERROR_NO_QUESTIONS = "错误：至少需要提供 1 个问题";
export const ERROR_TOO_MANY_QUESTIONS = `错误：每次调用最多允许提出 ${MAX_QUESTIONS} 个问题`;
export const ERROR_DUPLICATE_QUESTION = "错误：同一次调用中的问题文本不能重复";
export const ERROR_TOO_FEW_OPTIONS = `错误：每个问题至少需要提供 ${MIN_OPTIONS} 个选项`;
export const ERROR_RESERVED_LABEL = `错误：选项名称使用了保留词（${RESERVED_LABELS.join("、")}），请勿自行添加此类选项`;
export const ERROR_DUPLICATE_OPTION_LABEL = "错误：同一个问题下的选项名称不能重复";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

// validateQuestionnaire 校验归一化后的问题参数；reserved_label 优先于 duplicate_option_label。
export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
	if (typed.questions.length === 0) {
		return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
	}
	if (typed.questions.length > MAX_QUESTIONS) {
		return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };
	}

	const seenQuestions = new Set<string>();
	for (const q of typed.questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
		}
		seenQuestions.add(q.question);
	}

	for (const q of typed.questions) {
		if (q.options.length < MIN_OPTIONS) {
			return { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS };
		}
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (RESERVED_LABEL_SET.has(o.label)) {
				return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
			}
			if (seenLabels.has(o.label)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: ERROR_DUPLICATE_OPTION_LABEL,
				};
			}
			seenLabels.add(o.label);
		}
	}

	return { ok: true };
}

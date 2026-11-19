import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "用户取消了回答";
export const ENVELOPE_PREFIX = "用户已回答你的问题：";
export const ENVELOPE_SUFFIX = "请结合用户的回答继续后续工作。";

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (result.globalNote && result.globalNote.length > 0) {
		segments.push(`全局备注：${result.globalNote}。`);
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${ENVELOPE_PREFIX}${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`「${a.question}」=「${formatAnswerScalar(a, "envelope")}」`];
	if (a.preview && a.preview.length > 0) parts.push(`所选预览：${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`用户备注：${a.notes}`);
	return `${parts.join("；")}。`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

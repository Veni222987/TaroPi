import type { QuestionAnswer } from "./types.ts";

export const NO_INPUT_PLACEHOLDER = "（未输入）";

export type FormatAnswerVariant = "summary" | "envelope";

export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
	switch (a.kind) {
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join("、") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}

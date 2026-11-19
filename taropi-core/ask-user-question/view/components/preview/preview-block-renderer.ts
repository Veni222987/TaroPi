import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { t } from "../../../state/i18n-bridge.ts";
import type { QuestionData } from "../../../tool/types.ts";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.ts";
import type { PreviewLayoutMode } from "./preview-layout-decider.ts";

export const NOTES_AFFORDANCE_TEXT = "备注：按 n 添加";

function contentBudgetFor(mode: PreviewLayoutMode): number {
	const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
}

function innerWidthFor(width: number): number {
	return Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
}

export interface PreviewBlockRendererConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
}

export class PreviewBlockRenderer {
	private readonly theme: Theme;
	private readonly cache: MarkdownContentCache;

	constructor(config: PreviewBlockRendererConfig) {
		this.theme = config.theme;
		this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
	}

	hasAnyPreview(): boolean {
		return this.cache.hasAnyPreview();
	}

	has(optionIndex: number): boolean {
		return this.cache.has(optionIndex);
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode): number {
		const contentBudget = contentBudgetFor(mode);
		const innerWidth = innerWidthFor(width);
		const rawRows = this.cache.bodyFor(optionIndex, innerWidth).length;
		const contentRows = Math.min(rawRows, contentBudget);
		return BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD;
	}

	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		focused: boolean,
		notesVisible: boolean,
	): string[] {
		const contentBudget = contentBudgetFor(mode);
		const maxInnerWidth = innerWidthFor(width);

		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const truncated = raw.length > contentBudget;
		const hidden = truncated ? raw.length - contentBudget : 0;
		const contentLines = truncated ? raw.slice(0, contentBudget) : raw;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);

		const showAffordance = focused && !notesVisible && this.cache.has(optionIndex);
		const affordance = showAffordance
			? this.theme.fg("muted", t("preview.notes_affordance", NOTES_AFFORDANCE_TEXT))
			: "";
		return [...boxedLines, "", affordance];
	}
}

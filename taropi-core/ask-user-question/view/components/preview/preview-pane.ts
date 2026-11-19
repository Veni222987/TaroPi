import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.ts";
import type { StatefulView } from "../../stateful-view.ts";
import type { OptionListView } from "../option-list-view.ts";
import type { PreviewBlockRenderer } from "./preview-block-renderer.ts";
import {
	bodyWidths,
	columnWidths,
	decideLayout,
	PREVIEW_PADDING_LEFT,
	type PreviewLayoutMode,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

export {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
export { NOTES_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.ts";
export {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	BOX_MIN_CONTENT_WIDTH,
	renderBorderedBox,
	stripFenceMarkers,
} from "./preview-box-renderer.ts";
export {
	PREVIEW_COLUMN_GAP,
	PREVIEW_MIN_WIDTH,
	PREVIEW_PADDING_LEFT,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

export interface PreviewPaneProps {
	notesVisible: boolean;
	selectedIndex: number;
	focused: boolean;
	inputMode: boolean;
}

export interface PreviewPaneConfig {
	question: QuestionData;
	getTerminalWidth: () => number;
	optionListView: OptionListView;
	previewBlock: PreviewBlockRenderer;
}

export class PreviewPane implements StatefulView<PreviewPaneProps>, Component {
	private readonly question: QuestionData;
	private readonly getTerminalWidth: () => number;
	private readonly optionListView: OptionListView;
	private readonly previewBlock: PreviewBlockRenderer;
	private props: PreviewPaneProps;
	private globalLeftWidth: (paneWidth: number) => number = () => {
		throw new Error("PreviewPane.setGlobalLeftWidth must be called before render()");
	};

	constructor(config: PreviewPaneConfig) {
		this.question = config.question;
		this.getTerminalWidth = config.getTerminalWidth;
		this.optionListView = config.optionListView;
		this.previewBlock = config.previewBlock;
		this.props = { notesVisible: false, selectedIndex: 0, focused: false, inputMode: false };
	}

	setGlobalLeftWidth(getter: (paneWidth: number) => number): void {
		this.globalLeftWidth = getter;
	}

	private getAdaptiveLeft(paneWidth: number): number {
		return this.globalLeftWidth(paneWidth);
	}

	setProps(props: PreviewPaneProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.previewBlock.invalidate();
		this.optionListView.invalidate();
	}

	render(width: number): string[] {
		if (this.question.multiSelect === true) return this.optionListView.render(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width);
		if (this.props.inputMode) return this.optionListView.render(width);

		const mode = decideLayout(this.getTerminalWidth(), width);
		if (mode === "side-by-side") return this.renderSideBySide(width, mode);

		return [
			...this.optionListView.render(width),
			...Array(STACKED_GAP_ROWS).fill(""),
			...this.previewBlock.renderBlock(
				width,
				this.props.selectedIndex,
				mode,
				this.props.focused,
				this.props.notesVisible,
			),
		];
	}

	focusedItemRowRange(width: number): [number, number] {
		if (this.question.multiSelect === true) return this.optionListView.focusedItemRowRange(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.focusedItemRowRange(width);
		if (this.props.inputMode) return this.optionListView.focusedItemRowRange(width);
		const mode = decideLayout(this.getTerminalWidth(), width);
		if (mode === "stacked") return this.optionListView.focusedItemRowRange(width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth } = columnWidths(width, adaptiveLeft);
		return this.optionListView.focusedItemRowRange(leftWidth);
	}

	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		if (this.props.inputMode) return this.optionListView.render(width).length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		const previewBlockHeight = this.previewBlock.blockHeight(previewWidth, this.props.selectedIndex, mode);
		if (mode === "side-by-side") return Math.max(optionsHeight, previewBlockHeight);
		return optionsHeight + STACKED_GAP_ROWS + previewBlockHeight;
	}

	maxNaturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		if (this.props.inputMode) return this.optionListView.render(width).length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		let maxPreviewBlock = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const h = this.previewBlock.blockHeight(previewWidth, i, mode);
			if (h > maxPreviewBlock) maxPreviewBlock = h;
		}
		if (mode === "side-by-side") return Math.max(optionsHeight, maxPreviewBlock);
		return optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
	}

	private renderSideBySide(width: number, mode: PreviewLayoutMode): string[] {
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth, rightWidth, gap } = columnWidths(width, adaptiveLeft);
		const leftLines = this.optionListView.render(leftWidth);
		const rightLines = this.renderPaddedPreviewLines(rightWidth, mode);
		const rows = Math.max(leftLines.length, rightLines.length);
		const gapStr = " ".repeat(gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const leftRaw = leftLines[i] ?? "";
			const rightRaw = rightLines[i] ?? "";
			const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
			const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
			const joined = `${leftClamped}${leftPad}${gapStr}${rightRaw}`;
			out.push(truncateToWidth(joined, width, ""));
		}
		return out;
	}

	private renderPaddedPreviewLines(colWidth: number, mode: PreviewLayoutMode): string[] {
		const inner = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.previewBlock.renderBlock(
			inner,
			this.props.selectedIndex,
			mode,
			this.props.focused,
			this.props.notesVisible,
		);
		const boxWidth = Math.max(1, visibleWidth(contentLines[0] ?? ""));
		const boxAlignedPad = Math.max(PREVIEW_PADDING_LEFT, colWidth - boxWidth);
		return contentLines.map((line) => {
			if (line === "") return "";
			const pad = Math.max(PREVIEW_PADDING_LEFT, Math.min(boxAlignedPad, colWidth - visibleWidth(line)));
			return `${" ".repeat(pad)}${truncateToWidth(line, colWidth - pad, "")}`;
		});
	}
}

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer } from "@earendil-works/pi-tui";
import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay } from "../config.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { TabBar } from "./components/tab-bar.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.ts";

export const HINT_PART_ENTER = "回车选择";
export const HINT_PART_NAV = "↑/↓ 导航";
export const HINT_PART_NEW_LINE = "Shift+Enter 换行";
export const HINT_PART_CLEAR = "Ctrl+U 清空";
export const HINT_PART_TOGGLE = "空格切换";
export const HINT_PART_NOTES = "按 n 添加备注";
export const HINT_PART_TAB = "Tab 切换问题";
export const HINT_PART_CANCEL = "Esc 取消";
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} 折叠`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} 展开`;
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(
	KEY_PLACEHOLDER,
	formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY),
);
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_TAB, HINT_PART_CANCEL].join(
	" · ",
);
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "检查你的答案";
export const READY_PROMPT = "准备提交答案了吗？";
export const INCOMPLETE_WARNING_PREFIX = "⚠ 提交前请先回答以下问题：";

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

function renderFitsTerminal(natural: string[], spacerRows: number): string[] {
	return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
}

function renderChromeOnly(natural: string[], topFixed: number, bottomFixed: number, termRows: number): string[] {
	const chromeOnly = [...natural.slice(0, topFixed), ...natural.slice(natural.length - bottomFixed)];
	return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
}

function computeScrollStart(
	bodyRange: [number, number] | undefined,
	headingCount: number,
	availableMiddle: number,
	middleRows: number,
): number {
	if (!bodyRange) return 0;
	const focusedRowInMiddle = headingCount + bodyRange[0];
	const focusedHeight = bodyRange[1] - bodyRange[0];
	const idealStart = focusedRowInMiddle - Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
	return Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
}

function decorateOverflow(scrollableMiddle: string[], hasUp: boolean, hasDown: boolean, theme: Theme): void {
	if (hasUp && hasDown && scrollableMiddle.length === 1) {
		scrollableMiddle[0] = theme.fg("dim", OVERFLOW_BOTH);
		return;
	}
	if (hasUp && scrollableMiddle.length > 0) {
		scrollableMiddle[0] = theme.fg("dim", OVERFLOW_UP);
	}
	if (hasDown && scrollableMiddle.length > 0) {
		scrollableMiddle[scrollableMiddle.length - 1] = theme.fg("dim", OVERFLOW_DOWN);
	}
}

export type DialogState = QuestionnaireState;

export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Editor;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	submitPicker?: Component;
	getBodyHeight: (width: number) => number;
	getCurrentBodyHeight: (width: number) => number;
	getTerminalRows: () => number;
	collapseKey: string;
}

export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
			collapseKey: config.collapseKey,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
					notesInput: config.notesInput,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.liveProps.state;
		const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;

		const headingRowCache = strategy.headingRows(state);
		const headingCount = headingRowCache.length;
		const natural = this.buildContainerFromStrategy(strategy, headingRowCache).render(width);

		const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
		const bottomFixed = 1 + strategy.footerRowCount;
		const middleRows = natural.length - topFixed - bottomFixed;

		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount,
		);

		const termRows = this.config.getTerminalRows();

		if (natural.length + spacerRows <= termRows) {
			return renderFitsTerminal(natural, spacerRows);
		}

		const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
		if (availableMiddle === 0) {
			return renderChromeOnly(natural, topFixed, bottomFixed, termRows);
		}

		const scrollStart = computeScrollStart(
			strategy.focusedItemRowRange(width, state),
			headingCount,
			availableMiddle,
			middleRows,
		);
		const scrollableMiddle = natural.slice(topFixed + scrollStart, topFixed + scrollStart + availableMiddle);
		decorateOverflow(
			scrollableMiddle,
			scrollStart > 0,
			scrollStart + availableMiddle < middleRows,
			this.config.theme,
		);

		const result = [
			...natural.slice(0, topFixed),
			...scrollableMiddle,
			...natural.slice(natural.length - bottomFixed),
		];
		return result.length > termRows ? result.slice(0, termRows) : result;
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy, headingRowCache: Component[]): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		for (const c of headingRowCache) container.addChild(c);
		container.addChild(strategy.bodyComponent(state));
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		return container;
	}
}

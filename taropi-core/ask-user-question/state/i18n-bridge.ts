import { ROW_INTENT_META, type SentinelKind } from "./row-intent.ts";

const ZH_MESSAGES: Readonly<Record<string, string>> = {
	"editor.failed": "外部编辑器启动失败",
	"hint.cancel": "Esc 取消",
	"hint.clear": "Ctrl+U 清空",
	"hint.collapse": "{key} 折叠",
	"hint.enter": "回车选择",
	"hint.expand_line": "{key} 展开 · Esc 取消",
	"hint.navigate": "↑/↓ 导航",
	"hint.newline": "Shift+Enter 换行",
	"hint.notes": "按 n 添加备注",
	"hint.tab": "Tab 切换问题",
	"hint.toggle": "空格切换",
	"notes.header": "备注：",
	"notes.global_header": "全局备注：",
	"preview.hidden_lines": "已隐藏 {count} 行",
	"preview.no_preview": "暂无预览",
	"preview.notes_affordance": "备注：按 n 添加",
	"review.heading": "检查你的答案",
	"review.incomplete": "⚠ 提交前请先回答以下问题：",
	"review.ready": "准备提交答案了吗？",
	"review.global_hint": "按 n 添加全局备注",
	"review.note_label": "全局备注",
	"review.answer_note_prefix": "备注：",
	"rpc.custom_answer_title": "输入你的回答：",
	"rpc.multi_instructions": '输入所有适用选项的编号，用逗号分隔（例如 "1,3"），或直接输入自定义回答。',
	"sentinel.next": "下一个",
	"sentinel.other": "输入内容",
	"submit.cancel": "取消",
	"submit.label": "提交答案",
	"submit.tab": "提交",
	"multi.submit": "提交",
	"collapsed.label": "提问已折叠",
};

// t 查找内置中文文案，未命中时返回 fallback。
export function t(key: string, fallback: string): string {
	return ZH_MESSAGES[key] ?? fallback;
}

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}

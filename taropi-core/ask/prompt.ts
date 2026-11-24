// renderAskMessage 把一次性查证要求和原样问题合成一条用户消息。
export function renderAskMessage(question: string): string {
	return [
		"请先查证，再回答下面的问题。回答依次包含：",
		"1. 结论",
		"2. 至少一个可核对的详细例子",
		"3. 相关证据：文件路径与行号、命令输出，或可打开的链接",
		"能用工具时，先读仓库、跑只读命令，或使用已有搜索和抓取能力。核对不了的部分要明确写出没核对什么，不得把推测写成事实。仍遵守当前权限和所处阶段限制。",
		"",
		"问题：",
		question.trim(),
	].join("\n");
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlanConfig } from "./config.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function configFile(content?: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-config-"));
	directories.push(directory);
	const file = path.join(directory, "plan.json");
	if (content !== undefined) fs.writeFileSync(file, content);
	return file;
}

describe("阶段配置", () => {
	it("缺失、损坏或根类型错误使用独立默认配置", () => {
		for (const content of [undefined, "{", "null", "[]", "42"]) {
			const config = loadPlanConfig(configFile(content));
			expect(config.planning).toMatchObject({ model: "Au", blockedTools: ["edit", "write"] });
			expect(config.implementing.model).toBe("Ag");
			expect(config.idle.model).toBeUndefined();
			config.planning.blockedTools.length = 0;
			expect(loadPlanConfig(configFile()).planning.blockedTools).toEqual(["edit", "write"]);
		}
	});
	it("各阶段各字段分别覆盖，null 关闭自动切模型", () => {
		const config = loadPlanConfig(configFile(JSON.stringify({ planning: { model: " provider/model/id ", blockedTools: [" bash ", "bash"], prompt: "自定义规则" }, implementing: { model: null }, idle: { blockedTools: ["draw"] } })));
		expect(config.planning).toEqual({ model: "provider/model/id", blockedTools: ["bash"], prompt: "自定义规则" });
		expect(config.implementing.model).toBeUndefined();
		expect(config.idle.blockedTools).toEqual(["draw"]);
	});
	it("非法字段独立回退，合法字段仍保留", () => {
		const config = loadPlanConfig(configFile(JSON.stringify({ planning: { model: 42, blockedTools: ["read", 3], prompt: "合法提示" }, implementing: { blockedTools: [], prompt: " " }, idle: [] })));
		expect(config.planning).toMatchObject({ model: "Au", blockedTools: ["edit", "write"], prompt: "合法提示" });
		expect(config.implementing.blockedTools).toEqual([]);
		expect(config.implementing.prompt.trim()).not.toBe("");
	});
});

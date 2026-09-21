import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "./github.ts";

describe("parseGitHubUrl", () => {
	it("非 GitHub 域名返回 null", () => {
		expect(parseGitHubUrl("https://example.com/foo/bar")).toBeNull();
	});

	it("解析仓库根路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo", type: "root" });
	});

	it("解析 blob 文件路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/index.ts")).toEqual({ owner: "owner", repo: "repo", ref: "main", path: "src/index.ts", type: "blob" });
	});

	it("解析 tree 目录路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/src")).toEqual({ owner: "owner", repo: "repo", ref: "main", path: "src", type: "tree" });
	});

	it("非代码路径（issues/pull 等）返回 null", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/issues/1")).toBeNull();
	});

	it("非法 owner/repo 名称返回 null", () => {
		expect(parseGitHubUrl("https://github.com/-bad/repo")).toBeNull();
	});
});

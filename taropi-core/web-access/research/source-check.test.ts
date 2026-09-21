import { describe, expect, it } from "vitest";
import { buildResearchArtifact, classifySource, getResearchArtifact, storeResearchArtifact } from "./source-check.ts";
import { clearResults } from "../content/storage.ts";

describe("classifySource", () => {
	it("识别官方文档域名", () => {
		expect(classifySource("https://docs.example.com/guide")).toBe("official_docs");
	});

	it("识别 GitHub issue/PR 路径", () => {
		expect(classifySource("https://github.com/foo/bar/issues/1")).toBe("repo_issue");
	});

	it("识别论坛域名", () => {
		expect(classifySource("https://stackoverflow.com/questions/1")).toBe("forum");
	});

	it("非法 URL 归类为 unknown", () => {
		expect(classifySource("not a url")).toBe("unknown");
	});
});

describe("buildResearchArtifact", () => {
	it("按 URL 去重并保留 rank", () => {
		const artifact = buildResearchArtifact({
			query: "claim",
			results: [
				{ title: "A", url: "https://a.com", snippet: "snippet a" },
				{ title: "A dup", url: "https://a.com", snippet: "dup" },
				{ title: "B", url: "https://b.com", snippet: "snippet b" },
			],
		});
		expect(artifact.sources).toHaveLength(2);
		expect(artifact.sources[0].rank).toBe(1);
	});

	it("为每个来源的 snippet 生成一个证据片段", () => {
		const artifact = buildResearchArtifact({ query: "claim", results: [{ title: "A", url: "https://a.com", snippet: "important snippet" }] });
		expect(artifact.passages).toHaveLength(1);
		expect(artifact.passages[0].text).toBe("important snippet");
	});

	it("已抓取正文中提取与 query 相关的片段", () => {
		const artifact = buildResearchArtifact({
			query: "claim",
			results: [{ title: "A", url: "https://a.com", snippet: "" }],
			fetched: [{ url: "https://a.com", title: "A", content: "This mentions the important claim keyword directly. Unrelated sentence here.", error: null }],
		});
		expect(artifact.sources[0].fetched).toBe(true);
		expect(artifact.passages.some((p) => p.text.includes("claim"))).toBe(true);
	});

	it("抓取失败时记录 fetch_error", () => {
		const artifact = buildResearchArtifact({
			query: "claim",
			results: [{ title: "A", url: "https://a.com", snippet: "" }],
			fetched: [{ url: "https://a.com", title: "", content: "", error: "HTTP 404" }],
		});
		expect(artifact.sources[0].fetched).toBe(false);
		expect(artifact.sources[0].fetch_error).toBe("HTTP 404");
	});

	it("存储与检索 artifact", () => {
		clearResults();
		const artifact = buildResearchArtifact({ query: "claim", results: [] });
		storeResearchArtifact(artifact);
		expect(getResearchArtifact(artifact.id)?.query).toBe("claim");
		expect(getResearchArtifact("missing")).toBeNull();
	});
});

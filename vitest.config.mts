import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["taropi-core/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
			include: ["taropi-core/**/*.ts"],
			exclude: [
			"taropi-core/**/*.test.ts",
			"taropi-core/index.ts",
			"taropi-core/sub-agents/**",
		],
		},
	},
});

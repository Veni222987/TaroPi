import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{ find: "taropi-hud/api", replacement: path.resolve(import.meta.dirname, "taropi-hud/api.ts") },
			{ find: "taropi-hud/theme", replacement: path.resolve(import.meta.dirname, "taropi-hud/theme.ts") },
			{ find: "taropi-hud/protocol", replacement: path.resolve(import.meta.dirname, "taropi-hud/protocol.ts") },
			{ find: "taropi-hud", replacement: path.resolve(import.meta.dirname, "taropi-hud/index.ts") },
		],
	},
	test: {
		include: ["taropi-core/**/*.test.ts", "taropi-hud/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
			include: ["taropi-core/**/*.ts", "taropi-hud/**/*.ts"],
			exclude: [
			"taropi-core/**/*.test.ts",
			"taropi-core/index.ts",
			"taropi-core/sub-agents/**",
		],
		},
	},
});

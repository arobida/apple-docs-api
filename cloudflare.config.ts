import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "apple-docs-api",
		compatibilityDate: "2024-11-01",
		entrypoint,
	},
});

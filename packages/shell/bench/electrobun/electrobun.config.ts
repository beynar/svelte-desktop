import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "HelloElectrobun",
		identifier: "dev.bench.hello.electrobun",
		version: "1.0.0",
	},
	build: {
		bun: { entrypoint: "src/bun/index.ts" },
		copy: { "src/mainview/index.html": "views/mainview/index.html" },
		mac: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;

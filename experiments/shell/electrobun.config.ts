import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "svelte-desktop",
		identifier: "dev.sveltedesktop.app",
		version: "0.0.1",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			kit: "kit",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;

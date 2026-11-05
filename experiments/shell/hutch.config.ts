// @hutch cli=0.27.0-canary.4 cottontail=0.7.0-canary.6
export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
	electrobun: {
		version: "2.0.2-beta.22",
	},
};

import { defineConfig } from "blume";

export default defineConfig({
  title: "svelte-desktop",
  description: "Rendering Svelte 5 to native GPUI — no webview, no DOM.",
  theme: {
    accent: "orange",
    mode: "system",
  },
  ai: {
    llmsTxt: true,
  },
});

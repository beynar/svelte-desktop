import { defineConfig } from "blume";

export default defineConfig({
  title: "svelte-desktop",
  description: "Rendering Svelte 5 to native GPUI — no webview, no DOM.",
  content: {
    root: "docs",
  },
  theme: {
    accent: "orange",
    mode: "system",
  },
  navigation:{
    tabs:[{
      label: "Documentation",
      path: "/",
    },
  {
    label: "Styling",
    path: "/styling"
  }
  ]
  },
  // navigation.actions doesn't exist in blume@0.5.4's strict schema —
  // platform-api.mdx already surfaces via sidebar.order: 10.5
  ai: {
    llmsTxt: true,
  },
});

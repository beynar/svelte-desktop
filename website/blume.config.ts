import { defineConfig } from "blume";

export default defineConfig({
  title: "kitop",
  description:
    "Desktop apps from an unmodified SvelteKit app: one Vite plugin, one config file, Bun, the system web view, one signed binary.",
  logo: "/icon.svg",
  theme: {
    accent: "orange",
    radius: "md",
    mode: "system",
  },
  github: {
    owner: "beynar",
    repo: "svelte-desktop",
    dir: "website",
  },
  navigation: {
    tabs: [
      { label: "Guide", path: "/", icon: "book-open" },
      { label: "Host API", path: "/host", icon: "code" },
      { label: "Native code", path: "/native", icon: "cpu" },
    ],
  },
  agents: {
    llmsTxt: true,
  },
  deployment: {
    site: "https://svelte-desktop-docs.beynar.workers.dev",
  },
});

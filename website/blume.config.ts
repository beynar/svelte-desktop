import { defineConfig } from "blume";

export default defineConfig({
  title: "svelte-desktop",
  description:
    "Desktop and mobile apps from an unmodified SvelteKit app: one Vite plugin, one config file, Bun, the system web view, one signed binary.",
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
  agents: {
    llmsTxt: true,
  },
  deployment: {
    site: "https://svelte-desktop-docs.beynar.workers.dev",
  },
});

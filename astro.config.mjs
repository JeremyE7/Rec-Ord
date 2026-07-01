// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import AstroPWA from "@vite-pwa/astro";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    AstroPWA({
      registerType: "autoUpdate",
      strategies: "generateSW",
      injectRegister: "auto",
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: "REC-ORD",
        short_name: "REC-ORD",
        description: "Track your personal records.",
        theme_color: "#facc15",
        background_color: "#000000",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        cleanupOutdatedCaches: true,
        navigateFallback: "/",
      },
    }),
  ],
});

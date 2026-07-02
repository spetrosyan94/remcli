import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    build: {
        rolldownOptions: {
            output: {
                // React-рантайм — в отдельный чанк: вместе с route-level lazy (App.tsx)
                // главный чанк держится < 300 kB (страницы догружаются по переходу)
                codeSplitting: {
                    groups: [
                        { name: "react-vendor", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
                    ],
                },
            },
        },
    },
});

import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],
  platform: "node",
  target: "node24",
  dts: false,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false
  }
})

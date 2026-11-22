// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
var __electron_vite_injected_dirname = "/home/mosfet/dsh1/terminal-1000/apps/desktop";
var SHARED = "@t1000/shared";
var externalize = () => externalizeDepsPlugin({ exclude: [SHARED] });
var sharedAlias = {
  [SHARED]: resolve(__electron_vite_injected_dirname, "../../packages/shared/src/index.ts"),
  /**
   * kitty 内核以 vendor 形式随仓库走（`vendor/kitty-vt-wasm`）。
   *
   * 为什么不走 node_modules：pnpm 在这个环境里对 `@xterm/*` 之类的大包做 copyfile 会
   * EPERM（overlay fs + copy_file_range），装不上；vendor 目录同时解决了"打包后
   * 依赖树里找不到 wasm"的问题。
   */
  "kitty-vt-wasm": resolve(__electron_vite_injected_dirname, "vendor/kitty-vt-wasm/dist/index.js")
};
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalize()],
    resolve: {
      alias: {
        ...sharedAlias,
        "@main": resolve(__electron_vite_injected_dirname, "src/main")
      }
    },
    build: {
      // 不用 vite 的「先清空 outDir」：它会 rmSync 整个目录，沙箱的安全删除守卫会拦下
      // 批量删除（>50 个文件）。打包脚本改为「先 mv 到一边再构建」，同样干净且可回滚。
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalize()],
    resolve: {
      alias: sharedAlias
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        ...sharedAlias,
        "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer/src")
      }
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};

import { build, defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const btviewEntry = fileURLToPath(new URL('./src/btview/entry.ts', import.meta.url));
const btviewDir = fileURLToPath(new URL('./src/btview/', import.meta.url));

// btviewBundle 提供虚拟模块 virtual:btview-bundle：把行为树查看器（src/btview/entry.ts）
// 单独打成一段自带样式的 IIFE 脚本，默认导出这段代码的字符串。游戏页用它生成能离线打开的
// 录像 HTML 和实时窗口（见 src/btview/page.ts）。开发时改了 src/btview/ 下的文件会自动重新打包。
function btviewBundle(): Plugin {
  const virtualId = 'virtual:btview-bundle';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'btview-bundle',
    resolveId(id) {
      return id === virtualId ? resolvedId : null;
    },
    async load(id) {
      if (id !== resolvedId) return null;
      const output = await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          write: false,
          minify: true,
          emptyOutDir: false,
          lib: { entry: btviewEntry, formats: ['iife'], name: 'BtView', fileName: () => 'btview.js' },
        },
      });
      const results = Array.isArray(output) ? output : [output];
      const chunk = results
        .flatMap((result) => ('output' in result ? result.output : []))
        .find((item) => item.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('btview 打包失败：没有产出脚本');
      for (const module of chunk.moduleIds) if (module.startsWith(btviewDir)) this.addWatchFile(module);
      return `export default ${JSON.stringify(chunk.code)};`;
    },
    handleHotUpdate(context) {
      if (!context.file.startsWith(btviewDir)) return;
      const module = context.server.moduleGraph.getModuleById(resolvedId);
      if (module) context.server.moduleGraph.invalidateModule(module);
    },
  };
}

// Go 服务端嵌入 dist/（见 embed.go）。开发时照常运行 Go 服务端，再在这里 `npm run dev`：
// Vite 提供带热更新的客户端，并把游戏的 /ws、地图（/map.tmj、/maps/）和 /debug/scenes 转发给 Go 服务端（默认 8090 端口）。
export default defineConfig({
  plugins: [btviewBundle()],
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets' },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8090', ws: true },
      '/map.tmj': 'http://localhost:8090',
      '/maps': 'http://localhost:8090',
      '/debug/scenes': 'http://localhost:8090',
    },
  },
});

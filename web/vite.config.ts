import { defineConfig } from 'vite';

// Go 服务端嵌入 dist/（见 embed.go）。开发时照常运行 Go 服务端，再在这里 `npm run dev`：
// Vite 提供带热更新的客户端，并把游戏的 /ws、地图（/map.tmj、/maps/）和 /debug/scenes 转发给 Go 服务端（默认 8090 端口）。
export default defineConfig({
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

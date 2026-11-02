// vite.config.ts 的 btviewBundle 插件提供：打包好的查看器脚本（字符串）。
declare module 'virtual:btview-bundle' {
  const code: string;
  export default code;
}

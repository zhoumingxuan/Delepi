import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'
import path from 'path'

export default defineConfig({
  plugins: [
    electron([
      {
        // 主进程入口
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup(['.'])
        },
        vite: {
          resolve: {
            alias: {
              '@': path.resolve(__dirname, 'src'),
              '@main': path.resolve(__dirname, 'src/main'),
              '@shared': path.resolve(__dirname, 'src/shared'),
            },
          },
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['better-sqlite3', 'electron'],
            },
          },
        },
      },
      {
        // preload 入口
        entry: 'src/preload/preload.ts',
        onstart(args) {
          // 显式安全启动（禁用 reload()）：reload 在 electron 未启动时走插件无参 fallback，
          // 默认 argv=['.', '--no-sandbox'] 会隐式传入 --no-sandbox 致 preload 不执行；
          // 显式 startup(['.']) 与 main entry 一致，preload 变更后重启 electron 使新 preload 生效
          args.startup(['.'])
        },
        vite: {
          resolve: {
            alias: {
              '@': path.resolve(__dirname, 'src'),
              '@preload': path.resolve(__dirname, 'src/preload'),
              '@shared': path.resolve(__dirname, 'src/shared'),
            },
          },
          build: {
            outDir: 'dist/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // 过滤 antd 6.x "use client" 模块级指令警告（MODULE_LEVEL_DIRECTIVE）
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
            String(warning.message).includes('use client')) {
          return; // 静默丢弃该警告
        }
        warn(warning); // 其他警告正常输出
      },
    },
  outDir: 'dist/renderer',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@preload': path.resolve(__dirname, 'src/preload'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
})

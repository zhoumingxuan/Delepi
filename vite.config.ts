import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'
import path from 'path'

// ===== 客户端自动更新地址：构建期注入（唯一通道） =====
// 真实地址字面量只允许存在于 scripts/release-win10.cjs（发布脚本）；
// 本文件仅读取环境变量并转 define。vite-plugin-electron@1.1.1 子构建不继承
// 顶层 define（方案⑧章核实），故 main/preload 子配置内必须显式携带同一 define。
const updateBaseUrl = (process.env.DELEPI_UPDATE_BASE_URL ?? '').trim()

// 三处构建目标共用的注入集合（渲染端=顶层 define；main/preload=子配置 vite.define）
const updateUrlDefines = {
  __DELEPI_UPDATE_BASE_URL_DEFAULT__: JSON.stringify(updateBaseUrl),
}

export default defineConfig(({ command }) => {
  if (command === 'build' && !updateBaseUrl) {
    throw new Error(
      '[vite.config] 缺少 DELEPI_UPDATE_BASE_URL：真实更新地址只允许由发布脚本注入。' +
        '请改用 npm run release:win10-intranet 或 npm run release:win10-internet；' +
        '开发联调确需自定义地址时，请显式设置该环境变量后再构建。',
    )
  }
  if (command === 'serve' && !updateBaseUrl) {
    console.warn(
      '[vite.config] 未设置 DELEPI_UPDATE_BASE_URL：更新地址默认值为空串，开发期自动更新检查将失败（预期行为）。',
    )
  }

  return {
    define: {
      ...updateUrlDefines,
      // 授权码 L2 通道维持原状（本次机制冻结，不做任何改动）
      __DELEPI_UPDATE_ACCESS_KEY_OVERRIDE__: JSON.stringify(process.env.DELEPI_UPDATE_ACCESS_KEY ?? ''),
    },
    plugins: [
      electron([
        {
          // 主进程入口
          entry: 'src/main/index.ts',
          onstart(args) {
            args.startup(['.'])
          },
          vite: {
            // 子构建必须显式注入（不继承顶层 define）：替换 update-constants.ts 内的标识符
            define: { ...updateUrlDefines },
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
            // 同上：子构建显式注入（preload 当前不消费该常量，注入用于链路完备与未来防护）
            define: { ...updateUrlDefines },
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
  }
})

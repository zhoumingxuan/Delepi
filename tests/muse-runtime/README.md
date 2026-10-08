# M0 adapter、追加与内部保护回归

这些测试加载真实 TypeScript 模块，provider、Electron、配置与工具入口仅使用合成替身；不读取生产 userData，不联系真实模型，不启动 Python/Shell。

执行：

```sh
node --test tests/muse-runtime/*.test.cjs
```

- `adapter-inbox.test.cjs`：16 项，bundle 实际 factory/probe/CC/Responses 与 record store；覆盖探查取消及降级、失败实例所有权、传输失败计时器与监听清理、Responses 流取消/有状态配对、独立 insert API、初始化前单队列追加、FIFO/容量/停止和真实工具时间。
- `cancel-reason.test.cjs`：4 项，复用受控真实执行器入口，验证字符串、冻结 Error/对象取消原因保持、错误现场保存与 adapter close，以及最终日志写入期间取消不返回成功。
- `parser-protection.test.cjs`：2 项，实际 parser + cleanup helper，错误 temporary_paths 不删除协议摘要/成果/清理清单；实际复制后的交付路径进入内部保护引用。

可选 `MUSE_TEST_SOURCE_ROOT` 指向待对照源码；默认当前开发副本。只对快速失败子集运行原版负对照，避免旧版独立探查及600秒计时器影响验证进程：

```sh
MUSE_TEST_SOURCE_ROOT='<baseline-checkout>' node --test --test-name-pattern='pre-aborted|concurrent with unsupported|resolving despite|transport rejection|aborted partial final|initialization-time|capacity recovers|supplied settle timestamp' tests/muse-runtime/adapter-inbox.test.cjs
```

2026-10-07：开发副本22/22通过；原0.7负对照8/8检出对应缺陷。负对照失败是预期证据，不能报告为已修复源码的失败。主代理另有真实执行器/主层综合测试，覆盖 P01 派发、P02 批末屏障与真实时间、final/tool_calls、等待兄弟分支、取消和 observer 异常。

测试通过只覆盖受控生命周期，不代表真实provider质量/速度、Mac TCC权限、持久inbox/恢复或无人值守探索已经验收。

# 安装包目录说明

本目录是**默认**的安装包根目录（`packageDir`）。如果安装包放在 release 目录（例如
`/srv/releases/V1.7/win10/`），用 `config.json` 的 `platformPackageDirs` 指过去即可，
不需要改代码，也不要把本目录通过 Nginx 静态目录直接暴露。

## 一、目录与命名规则

```
packages/
├── win10/Delepi-Setup-0.8.1.exe
├── linux/Delepi-0.8.1-linux-x86_64.AppImage
└── mac/Delepi-0.8.1-mac-arm64.dmg
```

- 第一层只能是 `win10` / `linux` / `mac` 三个目录之一，大小写敏感；
- 第二层就是安装包文件本身，**不允许再嵌套子目录**；
- 文件名必须与 `data/manifest.json` 中对应平台的 `fileName` 逐字符一致；
- 文件名规则：字母或数字开头，只允许 `A-Z a-z 0-9 . _ -`，总长 1–128，
  禁止包含 `..`、`/`、`\`，禁止绝对路径；
- `.gitkeep` 仅用于占位，不会被当成安装包（清单里不会引用它）。

## 二、放包步骤（用 publish.py，不需要手算哈希）

1. 把安装包上传到平台目录，例如：

   ```bash
   scp Delepi-Setup-0.8.1.exe delepi@server:/srv/releases/V1.7/win10/
   ```

2. 先 `--dry-run` 看真实字节数与 SHA-256（只读，不会写任何文件）：

   ```bash
   cd /srv/delepi-update-server
   .venv/bin/python publish.py --dry-run \
     /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1
   ```

3. 确认无误后去掉 `--dry-run` 正式发布（同目录临时文件 + `os.replace` 原子替换清单）：

   ```bash
   .venv/bin/python publish.py \
     /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1
   ```

4. 客户端下一次检查更新时即可看到新版本（服务端按 mtime + size 自动热加载清单）。

> `data/manifest.json` 里 `0.8.1` 的 `size` / `sha256` 是**占位值**，只说明字段形状，
> 真实值必须由 `publish.py` 依据真实安装包生成。

如果包不在本目录下，用 `config.json` 的 `platformPackageDirs` 指定平台包根目录：

```json
{
  "platformPackageDirs": {
    "win10": "/srv/releases/V1.7"
  }
}
```

最终读取路径为 `/srv/releases/V1.7/win10/<fileName>`；该键只改目录，不改任何路径校验规则。

## 三、服务端如何判定「有包」

以下三个条件必须同时成立，`/check` 才会返回 `hasPackage: true`：

1. 清单里该平台的 `platforms.<platform>` 不是 `null`；
2. 文件真实存在于 `<包根目录>/<platform>/<fileName>`（默认 `packages/<platform>/`，
   可用 `config.json` 的 `platformPackageDirs` 按平台覆盖包根目录）；
3. 磁盘文件字节数与清单里的 `size` 完全相等。

任一条件不满足，`/check` 返回 `hasPackage: false`、`package: null`，
`/download` 返回 `200` + 空体 + `X-Delepi-Package-Status: absent`。

`sha256` 以磁盘文件的真实计算结果为准；若与清单不一致，服务端日志会打印一条 WARNING，
但响应里使用的是磁盘真实值，保证客户端下载后的完整性校验能通过。

## 四、回滚

旧安装包不要删除，回滚时只需要把 `data/manifest.json` 换回上一版即可。

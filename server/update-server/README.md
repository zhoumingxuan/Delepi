# Delepi 自动更新服务端（update-server）

基于 Python + FastAPI 的只读更新服务，**只提供两个业务接口**：

- `GET /check`：检查更新，返回版本清单与安装包元数据；
- `GET /download`：下载当前版本的安装包（流式发送）。

没有上传接口、没有后台管理页、没有登录页、没有用户体系、没有数据库、没有定时任务。
本目录整体上传到 Linux 服务器即可部署，前置 Nginx 提供 HTTPS。

> **安全提醒**：`config.example.json` 里的授权码 `delepi_update_K7mQ3vTz9LpW4aB2cD`
> 是**开发占位值**，上线前必须更换；该密钥同时写死在客户端安装包里，
> 更换后必须重新构建并发布客户端，详见第 11 章。

---

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| Python | 3.9 及以上（推荐 3.11 / 3.12） |
| 依赖 | `fastapi==0.115.6`、`uvicorn==0.32.1`（见 `requirements.txt`） |
| 网络 | 客户端必须通过 **HTTPS** 访问；明文 HTTP 下清单可被篡改，SHA-256 校验形同虚设 |
| 磁盘 | `packages/` 所在分区需能容纳所有平台的安装包 |

服务端本身只实现相对路径 `/check` 与 `/download`，对外地址固定为
`https://update.ai-cnlab.com`（**不带任何子路径**），因此 Nginx 反向代理**不做路径重写**，
直接把域名根路径转发到 `http://127.0.0.1:8080`，见第 6、7 章。

## 2. 安装

```bash
# 1) 解压（zip 内顶层目录就是 delepi-update-server/）
sudo mkdir -p /srv
sudo unzip delepi-update-server.zip -d /srv
cd /srv/delepi-update-server

# 2) 创建虚拟环境并安装依赖（建议用专用系统用户运行）
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

Windows 本机调试：

```bat
python -m pip install -r requirements.txt
start.bat
```

## 3. 配置

```bash
cd /srv/delepi-update-server
cp config.example.json config.json
chmod 600 config.json
vi config.json
```

配置项：

| 配置键 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `accessKeys` | string[] | `["delepi_update_K7mQ3vTz9LpW4aB2cD"]` | 同时有效的授权码列表，每项必须是 32 字符、字符集 `[A-Za-z0-9_-]` |
| `packageDir` | string | `./packages` | 安装包根目录；相对路径以 `update_config.py` 所在目录为基准 |
| `platformPackageDirs` | object | `{}`（无覆盖） | 可选。按平台覆盖包根目录，键只能是 `win10` / `linux` / `mac`，值为目录字符串；未配置的平台回退 `packageDir/<platform>` |
| `manifestPath` | string | `./data/manifest.json` | 版本清单文件路径；相对路径同上 |
| `httpReadTimeoutSeconds` | int | `10` | 读请求头超时（秒）；用于启动参数与 Nginx 配置建议，见第 9 章 |

补充规则：

- `config.json` 不存在时，服务端会回退到 `config.example.json` 的默认值，并在 stderr 打印告警；
- 环境变量 `DELEPI_UPDATE_ACCESS_KEYS`（英文逗号分隔）会与 `config.json` 的 `accessKeys` **合并**，
  用于「旧钥 + 新钥」双钥轮换；环境变量里的非法项会被忽略并告警；
- `config.json` 存在时**不会**再合并 `config.example.json` 里的开发占位密钥，
  避免「换了密钥但旧占位密钥仍然可用」；
- 授权码只从请求头 `X-Delepi-Update-Key` 读取，不接受 query 传参；
- 配置文件必须是 UTF-8（允许带 BOM），否则会回退默认值并告警。

`platformPackageDirs` 的完整语义（优先级从高到低）：

1. `config.json` 里的 `platformPackageDirs.<platform>` 优先；没有该键时才看
   `config.example.json`，再没有就回退 `packageDir/<platform>`；
2. 值是「该平台的包根目录」，最终安装包路径为 `<值>/<platform>/<fileName>`。
   例如服务器上安装包放在 `/srv/releases/V1.7/win10/`，就配置
   `"platformPackageDirs": {"win10": "/srv/releases/V1.7"}`；
3. 如果值本身已经以平台名结尾（例如 `/srv/releases/V1.7/win10`），说明它已经是该平台的
   最终目录，服务端不会再追加一次平台名（否则会变成 `.../win10/win10`）；
4. 相对路径仍以 `update_config.py` 所在目录为基准解析成绝对路径；
5. 键不在 `win10` / `linux` / `mac` 内、值是空字符串/非字符串、整体不是 JSON 对象时，
   只向 stderr 打印告警并忽略，对应平台回退 `packageDir/<platform>`，不会让服务启动失败；
6. 该键**只改变去哪个目录找包**：平台白名单、文件名白名单（`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）、
   目录包含校验、符号链接逃逸阻断这四重校验一条都不会放宽。

## 4. 放包与维护清单

目录与命名：

```
packages/
├── win10/Delepi-Setup-0.8.1.exe
├── linux/Delepi-0.8.1-linux-x86_64.AppImage
└── mac/Delepi-0.8.1-mac-arm64.dmg
```

- 第一层只允许 `win10` / `linux` / `mac`；
- 文件名必须与清单里的 `fileName` 逐字符一致，禁止 `..`、`/`、`\` 与绝对路径；
- 详细规则见 `packages/README.md`。

发版流程（**不需要改代码，也不需要手算哈希**）：

```bash
# 1) 把安装包上传到服务器（可以放在任意目录，例如 release 目录）
scp Delepi-Setup-0.8.1.exe delepi@server:/srv/releases/V1.7/win10/

# 2) 先 dry-run：只打印真实字节数与 SHA-256，不写任何文件
.venv/bin/python publish.py --dry-run \
  /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1

# 3) 确认无误后正式发布：原子替换 data/manifest.json
.venv/bin/python publish.py \
  /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1

# 4) 验证（服务端按 mtime + size 热加载清单，不需要重启）
curl -sS -H "X-Delepi-Update-Key: <32位授权码>" \
  "http://127.0.0.1:8080/check?version=0.0.0&platform=win10"
```

`publish.py` 的行为：

- 只使用 Python 标准库，不新增任何依赖，也不需要修改 `requirements.txt`；
- 流式读取安装包（1 MiB 分块），打印 `字节大小` 与 64 位小写十六进制 `SHA-256`；
- 写入清单走「同目录临时文件 + `os.replace`」原子替换，进程中断不会留下半个 JSON；
- 只改目标平台条目与 `latestVersion`（`--version` 省略时保持原版本），
  `updateNotes` 等其它字段与其它平台条目原样保留；
- `--dry-run` 只读不写：清单的字节内容与 `mtime` 都不会变化。

> **重要**：仓库里的 `data/manifest.json` 中 `0.8.1` 的 `size` 与 `sha256` 是**占位值**
> （`73400320` 与 64 个 `0`），只用于说明字段形状，**不能直接用于线上**。
> 真实值必须在服务器上由 `publish.py` 依据真实安装包生成后写入。

服务端每次请求都会 `stat` 清单，按 `mtime + size` 判断是否需要重新解析，因此改完清单立即生效，
不需要重启服务。**旧包不要删除**，回滚只需要换回上一份清单。

## 5. 启动

```bash
# 方式一：一键脚本（默认监听 127.0.0.1:8080，可用环境变量覆盖）
bash start.sh

# 换监听地址 / 端口（例如本机联调临时对外，或 8080 被占用）
DELEPI_UPDATE_HOST=0.0.0.0 DELEPI_UPDATE_PORT=9000 bash start.sh

# 方式二：直接命令（等价于 start.sh 的默认值）
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080

# 方式三：python 入口（固定 0.0.0.0:8080，仅本机调试用）
.venv/bin/python app.py
```

`start.sh` 支持两个环境变量（生产环境保持默认回环地址，由 Nginx 反代）：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DELEPI_UPDATE_HOST` | `127.0.0.1` | uvicorn 监听地址 |
| `DELEPI_UPDATE_PORT` | `8080` | uvicorn 监听端口；改端口后要同步改 Nginx 的 `proxy_pass` |

Windows：双击 `start.bat` 即可（等价于 `python -m uvicorn app:app --host 0.0.0.0 --port 8080`）。

## 6. 部署拓扑

### 6.1 对外地址：`https://update.ai-cnlab.com`（根路径，无子路径）

客户端 `baseUrl = https://update.ai-cnlab.com`，请求直接落在域名根路径：

```
https://update.ai-cnlab.com/check?version=0.8.0&platform=win10
https://update.ai-cnlab.com/download?platform=win10
```

因为 `baseUrl` **不带子路径**，Nginx **不做任何路径重写**：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;   # 末尾不要加 “/”
}
```

- 上游收到的路径与客户端请求路径逐字符一致：`/check` 就是 `/check`；
- 不要加 `rewrite`、不要写成 `proxy_pass http://127.0.0.1:8080/`、也不要再挂
  `/delepi/update` 之类的历史前缀（多一层或少一层路径都会 404，这是有意的）；
- 如果前面还有 CDN，必须让 CDN 回源到同样的根路径，并关闭缓存。

### 6.2 进程只监听回环地址

```bash
bash start.sh                 # 默认 127.0.0.1:8080
ss -lntp | grep 8080          # 期望 127.0.0.1:8080，而不是 0.0.0.0:8080
```

## 7. Nginx 反向代理示例

```nginx
# /etc/nginx/conf.d/delepi-update.conf
server {
    listen 443 ssl;
    http2 on;
    server_name update.ai-cnlab.com;

    ssl_certificate     /etc/letsencrypt/live/update.ai-cnlab.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/update.ai-cnlab.com/privkey.pem;

    # 服务端没有上传接口：限制请求体大小，避免误把大请求转给后端
    client_max_body_size 1m;

    # 客户端 baseUrl = https://update.ai-cnlab.com（不带子路径，因此不做路径重写）
    location / {
        proxy_pass http://127.0.0.1:8080;   # 末尾不要加 “/”
        proxy_http_version 1.1;

        # 请求头透传：Nginx 默认会透传，这里显式写出，便于审阅与排障
        proxy_pass_request_headers on;
        proxy_set_header Host                $host;
        proxy_set_header X-Real-IP           $remote_addr;
        proxy_set_header X-Forwarded-For     $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto   $scheme;
        proxy_set_header X-Delepi-Update-Key $http_x_delepi_update_key;

        # 可选：在边缘直接拒绝非 GET 请求（纵深防御）。
        # 注意：开启后非 GET 会在 Nginx 层得到 403，而不是服务端统一的 404；
        # 若要严格保持「任何失败都是同一个 404」，请保持注释状态。
        # limit_except GET { deny all; }

        # 安装包是流式下载：必须关闭缓冲，否则大文件会先落到 Nginx 临时文件再转发
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;

        # 单次下载最长 5 分钟；两次读之间最多空闲 300 秒
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        # 读请求头超时 10 秒（对应 config.json 的 httpReadTimeoutSeconds）
        client_header_timeout 10s;

        # 禁止缓存；4xx 原样透传（不要用 error_page 把 404 改写成登录页/错误页）
        proxy_cache off;
        proxy_no_cache 1;
        proxy_cache_bypass 1;

        # 本 location 只做反代，不配置 root/alias，避免 /packages 被静态枚举
        autoindex off;
    }
}
```

要点：

1. `proxy_pass` 末尾**不要**加 `/`：加了会改写 URI，`/check` 变成 `//check` 之类，直接 404；
2. `proxy_buffering off` 与 `proxy_max_temp_file_size 0` 是流式下载的关键；
   `proxy_read_timeout 300s` 是单次下载的读超时（大包慢网时需要足够余量）；
3. `client_max_body_size 1m` 与服务端「没有上传接口」保持一致；
4. `limit_except GET { deny all; }` 是**可选**写法：开启后非 GET 在边缘被 403 拒绝，
   与「统一 404」的取舍见上面注释；
5. 不要在 Nginx 层加 `auth_basic`、限流或自定义 401/403，否则会破坏「404 不可区分」；
6. 不要把 `packages/` 配成静态目录，也不要开启 `autoindex`；
7. 如果需要限流，请让限流后的响应仍然是统一的 404 语义（或直接不要限流）。

## 8. systemd 服务示例

```ini
# /etc/systemd/system/delepi-update.service
[Unit]
Description=Delepi Update Server (FastAPI + Uvicorn)
After=network.target

[Service]
Type=simple
User=delepi
Group=delepi
WorkingDirectory=/srv/delepi-update-server
# 授权码放环境文件，权限 600；不要写进 unit（systemctl show 能看到 unit 内容）
EnvironmentFile=/etc/delepi-update.env
# 监听地址与端口由 start.sh 读取这两个环境变量，必须与 Nginx 的 proxy_pass 一致
Environment=DELEPI_UPDATE_HOST=127.0.0.1
Environment=DELEPI_UPDATE_PORT=8080
ExecStart=/bin/bash /srv/delepi-update-server/start.sh
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/srv/delepi-update-server

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/delepi-update.env（权限 600，属主 root）
DELEPI_UPDATE_ACCESS_KEYS=旧密钥32位,新密钥32位
```

```bash
sudo useradd --system --home /srv/delepi-update-server --shell /usr/sbin/nologin delepi
sudo chown -R delepi:delepi /srv/delepi-update-server
sudo chmod 600 /etc/delepi-update.env
sudo systemctl daemon-reload
sudo systemctl enable --now delepi-update
sudo systemctl status delepi-update
journalctl -u delepi-update -f
```

> 如果 `platformPackageDirs` 指向 `/srv/releases/...` 这类部署目录，请确保 `delepi` 用户
> 对「包根目录 + 平台子目录 + 安装包文件」有读权限（服务端只读，不需要写权限）。

## 9. 超时、流式与已知限制

- **读请求头超时 10 秒**：`httpReadTimeoutSeconds` 会用于 `python app.py` 的 `timeout_keep_alive`，
  但 Uvicorn 本身没有独立的「读请求头超时」参数，生产环境请同时设置 Nginx 的 `client_header_timeout 10s`；
- **下载是流式的**：`FileResponse` 分块发送，不会把整包读入内存；因此 Nginx 必须 `proxy_buffering off`；
- **不支持断点续传**：响应头固定 `Accept-Ranges: none`，客户端也不要发送 `Range`；
- **stat 与发送之间的替换窗口**：服务端先 `stat` 再打开文件，若发版瞬间文件被替换，
  实际发送的是已打开句柄对应的内容；最终完整性由客户端下载后计算 SHA-256 与
  `X-Delepi-Package-Sha256` 比对兜底（不一致会删除文件并报 `HASH_MISMATCH`）；
- **哈希缓存**：安装包 SHA-256 按 `mtime + size` 缓存，替换文件后自动失效；首次检查大包时会有一次全文件读取开销；
- **清单热加载**：解析失败时保留上一份可用清单并写 ERROR 日志，避免一次半写入导致全平台不可用；
- **按平台目录**：`platformPackageDirs` 只改变「去哪个目录找包」，哈希缓存按「文件绝对路径 + mtime + size」
  记录，换目录不会误用旧缓存；四重路径校验与默认目录完全一致。

## 10. 常见故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 所有请求都返回 404（含正确密钥） | 启动日志显示「有效授权码=0 把」；密钥长度不是 32 或含非法字符；`config.json` 未被读取 | 看启动日志；用 `curl -H "X-Delepi-Update-Key: <32位>"` 复测；确认 `config.json` 与 `app.py` 同目录 |
| 密钥正确、参数正确仍 404 | 清单缺失或字段校验失败（`updateNotes` 含 `<`/`>`、`sha256` 不是 64 位小写十六进制、`size` 非正整数） | 查看日志「清单字段校验失败」；修正 `data/manifest.json` |
| `/check` 正常但 `hasPackage=false` | 文件不在 `packages/<platform>/`、文件名不一致、`size` 不一致、`platforms.<platform>` 为 `null` | 按第 4 章核对三元组；看日志「安装包文件不存在 / 大小与清单不一致」 |
| 配了 `platformPackageDirs` 仍 `hasPackage=false` | 实际目录不是 `<配置值>/<platform>/`、值末尾已带平台名却又多套了一层、目录对服务用户不可读 | 看启动日志的「平台包目录覆盖」；`ls -l <实际目录>` 核对文件名与字节数 |
| `/download` 返回 200 但空体 | 无适配包（`X-Delepi-Package-Status: absent`），这是设计行为 | 放包并更新清单；不要改成 204/404 |
| 502 Bad Gateway | uvicorn 没启动、端口不对、只监听 127.0.0.1 而 Nginx 连不上 | `systemctl status` / `ss -lntp | grep 8080` |
| 下载卡顿或极慢 | 未关闭 `proxy_buffering`、`proxy_read_timeout` 太短 | 按第 7 章配置 |
| 出现 401/403/跳转 | 反代层加了 `auth_basic`、限流或 `error_page` 改写 | 去掉这些配置，保持 4xx 原样透传 |
| 清单改了不生效 | 覆盖后 `mtime + size` 恰好没变 | `touch data/manifest.json`，或使用原子替换 |
| 中文乱码 | 清单不是 UTF-8 | 另存为 UTF-8（允许 BOM） |
| 端口被占用 | 8080 已被其它进程使用 | 换端口并同步改 Nginx，或停掉占用进程 |

本地快速验证「404 不可区分」：

```bash
curl -sS -D /tmp/a.h -o /tmp/a.b \
  -H "X-Delepi-Update-Key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
  "http://127.0.0.1:8080/check?version=0.0.0&platform=win10"
curl -sS -D /tmp/b.h -o /tmp/b.b "http://127.0.0.1:8080/__no_such_path__"
cmp /tmp/a.b /tmp/b.b && wc -c /tmp/a.b    # 期望：无差异，22 字节
```

也可以直接运行本目录的 `selfcheck.py`（要求服务已在本机 8080 启动），见第 12 章。

## 11. 如何更换授权码并同步客户端

授权码同时存在于**服务端配置**与**客户端安装包**，两端必须一致。更换步骤：

1. 生成一把新密钥（32 字符，base64url 字符集）：

   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```

2. 在服务端把新密钥**追加**到 `DELEPI_UPDATE_ACCESS_KEYS`（或用 `config.json` 的 `accessKeys` 数组）：

   ```bash
   # /etc/delepi-update.env
   DELEPI_UPDATE_ACCESS_KEYS=旧密钥32位,新密钥32位
   ```

   重启服务，确认新旧密钥都能通过（这是轮换窗口，建议保留至少 30 天）。

3. 修改客户端的构建期授权码配置，重新构建并发布客户端（客户端密钥写死在安装包里，
   不重新构建就无法更换）。

4. 等旧客户端基本完成升级后，再从环境变量 / `accessKeys` 中删除旧密钥并重启服务。

5. 验证：

   ```bash
   # 旧密钥应开始返回 404；新密钥应返回 200
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -H "X-Delepi-Update-Key: 新密钥32位" \
     "http://127.0.0.1:8080/check?version=0.0.0&platform=win10"
   ```

注意事项：

- 更换授权码**不会**改变下载地址；两者互相独立；
- 不要在客户端里同时保留多把密钥（客户端只需一把；多把并存会扩大泄露面）；
- 服务端支持多把密钥，只是为了让轮换期间旧客户端不中断；
- 修改 `config.json` 后必须重启进程（配置在进程启动时读取一次）。

## 12. 自检脚本

`selfcheck.py` 只用 Python 标准库，有两种模式：

```bash
# 默认：进程内契约自检（不需要先启动服务，退出码 0 即全部通过）
python3 selfcheck.py

# 真实 HTTP 自检：先启动服务，再让脚本作为客户端跑四组请求
bash start.sh &
python3 selfcheck.py --mode http --base-url http://127.0.0.1:8080 --key <32位授权码>
```

- 默认模式：直接 `import app`，优先用 FastAPI TestClient 对同一个应用对象发请求，断言
  `/check` 恰好五字段且不含 `hasUpdate`、`/download` 的 `absent`/`present` 两条路径、
  统一 404 的 22 字节、方法矩阵全 404、`/docs` 类全 404、`app.routes` 恰两条、
  `user_middleware` 为空，以及 `platformPackageDirs` 解析语义与路径四重校验；
- 本机缺少 fastapi 时自动降级为「纯函数级 + 静态」自检，并在输出中明确打印降级说明；
- `--mode http` 与旧版行为一致：四组请求 + 逐字节比对，退出码 0 通过、1 失败、2 连不上服务。

临时清单与合成安装包都放在系统临时目录，自检结束即删除，不会改动 `data/` 与 `packages/`。

## 13. 安全与范围说明

- 授权码只放请求头，不落 URL、不进访问日志、不进浏览器历史；
- 日志不记录授权码原文，也不记录请求头全集；
- 所有失败都是同一个 404，不泄露「路径是否存在」「是否鉴权失败」；
- 不开 `/docs`、`/redoc`、`/openapi.json`，不注册 CORS，不挂静态目录；
- 不实现上传、后台、登录、用户体系、数据库、定时任务；
- 生产环境必须开启 TLS，并定期轮换授权码。

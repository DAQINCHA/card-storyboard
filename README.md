# 卡片分镜

卡片分镜是一套适合局域网部署的多人分镜管理工具。它以卡片组织镜头信息，支持图片、场景、画幅、镜头排序和 PDF 导出，并提供账户、项目权限、匿名只读分享与编辑冲突保护。

## 主要功能

- 创建、复制、置顶、搜索和管理分镜项目
- 编辑镜头图片、景别、运镜、时长、台词及备注
- 调整镜头顺序，批量添加或删除分镜
- 按项目画幅分页导出 PDF
- 使用 owner、editor、viewer 三级项目权限协作
- 创建有期限且可撤销的匿名只读链接
- 通过编辑锁和版本检查避免多人覆盖内容
- 管理员统一管理账户和项目

## 运行要求

- Docker Compose，推荐用于 NAS 或局域网部署
- 或 Node.js 22.5 及以上版本
- 默认服务端口：`5199`
- 数据库位置：`data/storyboard.db`

项目只使用 Node.js 内置模块，不需要安装 npm 依赖。

## Docker Compose 部署

仓库中的 `compose.yaml` 默认公共访问地址为 `http://localhost:5199`，同时允许使用 `http://127.0.0.1:5199`。如果需要从其他设备通过 NAS 地址访问，请先在项目目录创建 `.env`：

```dotenv
STORYBOARD_PUBLIC_ORIGIN=http://192.168.1.20:5199
STORYBOARD_ALLOWED_ORIGINS=http://192.168.1.20:5199,http://localhost:5199,http://127.0.0.1:5199
```

`STORYBOARD_PUBLIC_ORIGIN` 必须是用户在浏览器中实际访问的完整地址。不要填写 `0.0.0.0`，它只用于服务监听。

首次部署先创建管理员并初始化数据库：

```sh
docker compose run --rm -it card-storyboard node server.js setup-admin --username admin
```

管理员密码必须为 12 至 128 个字符，输入过程不会显示在终端中。初始化完成后启动服务：

```sh
docker compose up -d
```

查看服务状态和日志：

```sh
docker compose ps
docker compose logs -f card-storyboard
```

修改 `.env` 或 Compose 配置后，重新创建容器使配置生效：

```sh
docker compose up -d --force-recreate
```

停止服务：

```sh
docker compose down
```

## 本地运行

先初始化管理员：

```sh
npm run setup-admin
```

再启动服务：

```sh
export STORYBOARD_ALLOW_INSECURE_HTTP=1
npm start
```

浏览器打开 `http://localhost:5199`。HTTP 兼容模式仅适合受信任的本机或局域网环境。

## 账户与权限

自助注册默认开启。新用户注册时需填写用户名、显示名称和 12 至 128 个字符的密码，注册完成后可直接登录，但不会自动获得已有项目权限。

项目所有者可以在“成员与分享”中授予以下权限：

| 权限 | 能力 |
| --- | --- |
| owner | 编辑项目、管理成员与分享、转移所有权 |
| editor | 查看并编辑项目 |
| viewer | 仅查看项目 |

管理员可以访问和管理全部项目，并可创建、停用、删除普通账户或重置密码。管理员创建或重置的账户使用临时密码 `123456`，用户首次登录后必须修改密码。

如需关闭自助注册，在 `.env` 中设置：

```dotenv
STORYBOARD_ALLOW_REGISTRATION=0
```

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `5199` | 服务监听端口 |
| `STORYBOARD_DATA_FILE` | `data/storyboard.db` | SQLite 数据库路径 |
| `STORYBOARD_PUBLIC_ORIGIN` | `http://localhost:5199` | 浏览器使用的公共入口 |
| `STORYBOARD_ALLOWED_ORIGINS` | 与公共入口相同 | 允许的 Origin 和 Host，多个值用英文逗号分隔 |
| `STORYBOARD_ALLOW_INSECURE_HTTP` | 未开启 | 设为 `1` 后允许 HTTP，仅用于受信局域网 |
| `STORYBOARD_ALLOW_REGISTRATION` | 开启 | 设为 `0` 后关闭自助注册 |

面向公网部署时应使用 HTTPS，并通过反向代理、访问控制和防火墙限制服务入口。

## 从旧版本升级

多账户版本不会自动修改旧数据库。如果日志出现 `setup-admin or migration is required`，服务会在监听端口前退出。

1. 停止服务，并确认所有用户已经停止编辑。
2. 将 `data/storyboard.db` 复制到项目目录之外，保留一份额外备份。
3. 确认 Node.js 版本不低于 22.5。
4. 执行管理员初始化与迁移命令。

Docker 部署使用：

```sh
docker compose run --rm -it card-storyboard node server.js setup-admin --username admin
```

本地部署使用：

```sh
node server.js setup-admin --username admin
```

命令会依次执行数据库完整性检查、一致性备份、事务迁移、旧项目归属和迁移后校验。自动备份保存在 `data/backups/`，并附带 `.sha256` 校验文件。

迁移完成后可执行只读验证。Docker 部署使用：

```sh
docker compose run --rm card-storyboard node server.js verify-db
```

本地部署使用：

```sh
npm run verify-db
```

首次验收应确认旧项目数量、名称、图片与 PDF 布局，并实际测试 editor、viewer 和匿名只读链接。

## 备份与恢复

日常备份应至少包含 `data/storyboard.db`，并存放在项目目录和 NAS 之外。复制数据库前应停止服务，避免得到不一致的文件。

恢复操作会丢弃备份创建后的账户、分享和编辑记录。必须先停止服务，并保留当前数据库。Docker 部署使用：

```sh
docker compose run --rm card-storyboard node server.js restore-db --backup data/backups/storyboard-v0-时间戳.db --confirm=RESTORE
```

本地部署使用：

```sh
node server.js restore-db --backup data/backups/storyboard-v0-时间戳.db --confirm=RESTORE
```

恢复命令会验证备份，为当前数据库再创建一份一致性备份，并保留被替换的数据库文件。恢复旧版 schema 后，再次运行当前版本前需要重新执行 `setup-admin`。

## 开发与检查

```sh
npm run check
npm test
```

`npm run check` 检查服务端和前端 JavaScript 语法，`npm test` 运行 HTTP、权限、迁移和数据安全相关测试。

## 安全说明

- HTTP 兼容模式不能抵御流量监听或中间人攻击，只能用于受信局域网。
- 不要将数据库、备份、日志、`.env` 或管理员密码提交到 Git。
- 自助注册按来源 IP 限制为每 15 分钟最多 5 次请求；公开部署仍建议关闭注册或增加上游访问控制。
- Session Cookie 使用 HttpOnly 和 SameSite；HTTPS 模式会额外启用 Secure 与 HSTS。
- 注册、登录、账户管理、成员变更、所有权转移和分享链接操作会写入安全审计表。

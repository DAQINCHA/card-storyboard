# Docker Compose 部署

卡片分镜可以通过 Docker Compose 部署，适合 NAS 或局域网环境。仓库根目录的 `compose.yaml` 镜像使用 `node:22-bookworm-slim`，服务监听 `5199` 端口，代码目录以只读方式挂载，数据库写入 `./data/storyboard.db`。项目完整功能介绍见 [README.md](README.md)。

## 首次部署

`compose.yaml` 默认公共访问地址为 `http://localhost:5199`，同时允许使用 `http://127.0.0.1:5199`。如果需要从其他设备通过 NAS 地址访问，请先在项目目录创建 `.env`：

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

## 升级与迁移

从旧版本升级时，先停止服务并备份数据库，再执行管理员初始化和迁移：

```sh
docker compose run --rm -it card-storyboard node server.js setup-admin --username admin
```

命令会依次执行数据库完整性检查、一致性备份、事务迁移、旧项目归属和迁移后校验。自动备份保存在 `data/backups/`，并附带 `.sha256` 校验文件。

迁移完成后可执行只读验证：

```sh
docker compose run --rm card-storyboard node server.js verify-db
```

首次验收应确认旧项目数量、名称、图片与 PDF 布局，并实际测试 editor、viewer 和匿名只读链接。

## 备份与恢复

日常备份应至少包含 `data/storyboard.db`，并存放在项目目录和 NAS 之外。复制数据库前应停止服务，避免得到不一致的文件。

恢复操作会丢弃备份创建后的账户、分享和编辑记录。必须先停止服务，并保留当前数据库：

```sh
docker compose run --rm card-storyboard node server.js restore-db --backup data/backups/storyboard-v0-时间戳.db --confirm=RESTORE
```

恢复命令会验证备份，为当前数据库再创建一份一致性备份，并保留被替换的数据库文件。恢复旧版 schema 后，再次运行当前版本前需要重新执行 `setup-admin`。

## 安全说明

- 容器内默认开启 HTTP 兼容模式（`STORYBOARD_ALLOW_INSECURE_HTTP=1`），仅适合受信任的局域网环境。
- 不要将数据库、备份、日志、`.env` 或管理员密码提交到 Git。
- 面向公网部署时应改用 HTTPS，并在 Compose 或上游反向代理中增加访问控制与防火墙限制。

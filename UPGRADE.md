# 多账户版本升级指南

新版不会自动修改旧数据库。看到 `setup-admin or migration is required` 时，服务会在监听端口前退出。

## 升级前

1. 通知所有用户停止编辑。
2. 使用项目自带的停止脚本停止服务，并确认 5199 端口不再监听。
3. 额外复制 `data/storyboard.db` 到项目目录之外。
4. 确认 Node.js 版本不低于 22.5。

## 配置局域网地址

推荐配置 HTTPS。暂时只能使用 HTTP 时，应将以下值改为用户实际访问的固定主机名或 IP，并明确接受局域网流量可被监听的风险：

```sh
export STORYBOARD_PUBLIC_ORIGIN=http://storyboard.lan:5199
export STORYBOARD_ALLOWED_ORIGINS=http://storyboard.lan:5199
export STORYBOARD_ALLOW_INSECURE_HTTP=1
```

多个合法入口用英文逗号分隔 `STORYBOARD_ALLOWED_ORIGINS`。请求的 `Host` 也必须包含在这些入口中。

## 创建初始管理员并迁移

在服务停止时执行：

```sh
node server.js setup-admin --username admin
```

密码通过终端隐藏输入，不会出现在命令历史中。命令会依次执行完整性检查、一致性备份、事务迁移、旧项目归属和迁移后校验。自动备份位于 `data/backups/`，并附带 `.sha256` 校验文件。

Docker 部署使用：

```sh
docker compose run --rm -it card-storyboard node server.js setup-admin --username admin
```

迁移后可在服务停止或运行时执行只读验证：

```sh
node server.js verify-db
```

## 启动与首次验收

1. 启动服务并登录管理员账户。
2. 确认旧项目数量、名称、图片和 PDF 导出布局。
3. 创建两个普通账户，完成 editor/viewer 分享测试。
4. 创建一个短期匿名链接，验证只读和撤销。
5. 验收完成前保留旧库外部副本及 `data/backups/` 中的自动备份。

普通账户由管理员创建或重置后，临时密码固定为 `123456`，首次登录必须修改为 12–128 字符的新密码；完成改密前不能访问项目。管理员能管理全部项目；相关越权访问、成员变更、密码重置、所有权转移和链接操作会写入安全审计表。

## 恢复备份

恢复会丢弃备份创建之后的账户、分享和编辑记录。必须先停止服务，并先保留当前库：

```sh
node server.js restore-db --backup data/backups/storyboard-v0-时间戳.db --confirm=RESTORE
```

恢复命令会校验备份，先为当前库再创建一份一致性备份，并保留被替换的数据库文件。恢复 v0 后只能运行旧版程序；再次运行新版前需要重新执行 `setup-admin`。

## 安全说明

- HTTP 兼容模式只适用于受信局域网，不能抵御流量监听或中间人攻击。
- Session Cookie 使用 HttpOnly 和 SameSite；HTTPS 模式额外强制 Secure 与 HSTS。
- 不要将数据库、备份、日志或管理员密码放入 Git。
- 启停脚本只操作自身 PID 文件记录的进程，不会按端口终止未知程序。

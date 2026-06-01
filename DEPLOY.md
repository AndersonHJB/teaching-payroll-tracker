# 部署到服务器

本应用是一个纯 Python 标准库写的服务（`server.py`，无第三方依赖，自带 SQLite），部署很简单：把代码放到服务器、用 Python 跑起来、再用反向代理加上 HTTPS 即可。

适用环境：一台有公网 IP 的 Linux 服务器（Ubuntu/Debian/CentOS 等），已装 **Python 3.8+**。

---

## 1. 拉取代码

```bash
cd /opt
git clone https://github.com/AndersonHJB/teaching-payroll-tracker.git
cd teaching-payroll-tracker
```

先手动跑一下确认正常（`Ctrl+C` 退出）：

```bash
python3 server.py 8000
# 浏览器访问 http://服务器IP:8000 应能打开
```

> 数据库文件 `data.db` 会自动生成在该目录下。**它就是你的全部数据**，请纳入备份（见第 5 节）。

---

## 2. 用 systemd 常驻运行（推荐，Linux）

新建服务文件 `/etc/systemd/system/teaching-payroll.service`：

```ini
[Unit]
Description=Teaching Payroll Tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/teaching-payroll-tracker
ExecStart=/usr/bin/python3 server.py 8000
Environment=LOCAL_ONLY=1
Environment=PT_DB=/var/lib/teaching-payroll/data.db
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

> `Environment=PT_DB=...` 把数据库放到**仓库目录之外**（关键，见第 7 节）。先建好目录并授权：
> ```bash
> sudo mkdir -p /var/lib/teaching-payroll
> sudo chown www-data:www-data /var/lib/teaching-payroll
> ```
> `Environment=LOCAL_ONLY=1` 让服务只监听 `127.0.0.1`（仅本机），由 Nginx 反代对外暴露——推荐做法，外网不能直连后端端口。不打算用反向代理就去掉这一行（监听 `0.0.0.0`）。

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now teaching-payroll
sudo systemctl status teaching-payroll      # 查看状态
sudo journalctl -u teaching-payroll -f       # 查看日志
```

### 简易替代（不想用 systemd）

```bash
nohup python3 server.py 8000 >/var/log/teaching-payroll.log 2>&1 &
```

---

## 3. 反向代理 + HTTPS

### 方案 A：Caddy（最省事，自动签发 HTTPS）

`/etc/caddy/Caddyfile`：

```
your-domain.com {
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo systemctl reload caddy
```

域名解析到服务器后，Caddy 会自动申请并续期证书。

### 方案 B：Nginx

`/etc/nginx/conf.d/teaching-payroll.conf`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 20m;   # 允许较大的照片上传

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
# 再用 certbot 配 HTTPS：
sudo certbot --nginx -d your-domain.com
```

---

## 4. 首次设置

1. 浏览器打开站点，进入「设置」。
2. **设置一个强管理员密码**（公网部署务必设置；未设密码时任何人都能编辑）。
3. 之后未登录只能查看，管理员登录后才能编辑。

> 安全提示：默认「未登录可查看」意味着任何人都能看到学员名单和上课照片。如不希望对外公开，可在 Nginx/Caddy 层加 IP 白名单或 HTTP Basic Auth；或告诉作者加「访客也需登录」。

---

## 5. 备份数据

全部数据（含照片）都在数据库这一个文件里（按上面的配置在 `/var/lib/teaching-payroll/data.db`）。

- **手动**：直接复制该 `data.db`。
- **在网页里**：「设置 → 下载数据库（.db）」。
- **定时备份**（cron，每天凌晨 3 点）：

```bash
0 3 * * * sqlite3 /var/lib/teaching-payroll/data.db ".backup '/backup/data-$(date +\%F).db'"
```

> SQLite 用 WAL 模式，运行中用 `.backup` 命令能拿到严格一致的快照；直接 `cp` 一般也可用。

---

## 6. 更新版本

```bash
cd /opt/teaching-payroll-tracker
git pull
sudo systemctl restart teaching-payroll
```

更新代码**不会动你的数据**（原因见下一节）。

---

## 7. 数据库位置与更新安全（重要）

更新代码时数据不会丢，有两道保障：

1. **`data.db` 不在 git 里**：仓库的 `.gitignore` 已忽略 `data.db`（及 `-wal`/`-shm`），git 根本不跟踪它，所以 `git pull`、切分支、`git reset` 都不会覆盖或与它冲突。
2. **数据库放在仓库目录之外**：按本文配置用 `PT_DB=/var/lib/teaching-payroll/data.db`，数据库**根本不在代码目录里**。即便误用 `git clean -fdx` 清理仓库，也波及不到它。

> 强烈建议生产环境务必设置 `PT_DB` 指向仓库外的路径（如 `/var/lib/teaching-payroll/`）。不设置时默认在 `项目目录/data.db`（仅靠第 1 条保障，本地够用，但服务器更推荐放仓库外）。

**关于数据库结构升级**：后续版本若需要改表结构，代码用的是**追加式**迁移（`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ADD COLUMN`），只会在你现有数据库上新增、**绝不删除已有数据**（例如本项目从"只有日期"升级到"日期+时间"时，就是自动给旧库补列、旧记录原样保留）。所以**直接 `git pull` + 重启即可，无需迁移已有的 SQLite 文件**。

---

## 端口与防火墙

- 用反向代理时：只需放行 80/443；后端 8000 留给本机即可（配合 `LOCAL_ONLY=1`）。
- 不用反向代理、直接对外：放行你选的端口（如 8000），并务必设管理员密码、尽量加 HTTPS。

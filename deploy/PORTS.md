# 固定端口与地址表（不可随意变更）

> 2026-10-09 定稿。用户明确要求：**前端地址永远固定为 http://43.138.212.106:55500/**，任何部署/配置变更不得改变以下对外端口。

## 对外固定端口（经 frp 穿透，frps allowPorts 限 55500-55600）

| 用途 | 固定地址 | 链路 |
|---|---|---|
| **Web 前端** | `http://43.138.212.106:55500/` | frp → 树莓派 nginx 60500（SPA 静态 + /v1 反代 API，同域无 CORS） |
| **同步 API** | `http://43.138.212.106:55505`（含 /healthz） | frp → 树莓派 60505 → 127.0.0.1:60505（node 服务） |
| **SSH 运维隧道**（2026-10-09 新增） | `ssh -p 55522 root@43.138.212.106` | frp → 树莓派 22（密钥免密：本机 id_ed25519 已装 root authorized_keys） |
| 用户其他服务 | emby 55566 / alist 55570 | 勿占用 |

## 树莓派内部端口（不出内网）

| 服务 | 端口 |
|---|---|
| node API 服务 | 60505（systemd ledgerone.service，/opt/node20 v20.19.5 跑 /opt/ledgerone/dist/main.js） |
| nginx Web | 60500（/etc/nginx/sites-available/ledgerone；index.html 已加 no-cache 头防旧版缓存） |
| MariaDB | 3306→本机 33307 仅回环 |
| frpc 管理面板 | 50000（本机） |

## 约定

1. 前端/API 对外端口 = 上表，**永远不变**；新需求在 55523-55600 内挑未占用端口。
2. Web 部署流程：Mac `apps/web` 内 `node node_modules/vite/bin/vite.js build` → `scp -r dist/. root@192.168.1.16:/opt/ledgerone-web/` → 清理 assets 内未被新 index.html 引用的旧 hash 文件 → 回滚备份在 `/opt/ledgerone-web-bak`。
3. 树莓派 SSH：局域网 `root@192.168.1.16`（密码见用户）或公网 55522（密钥）。

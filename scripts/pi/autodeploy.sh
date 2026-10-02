#!/bin/bash
# LedgerOne 树莓派自动部署:轮询 GitHub Release(pi-latest),有新版本则热切换。
# 由 ledgerone-autodeploy.timer 每 5 分钟调用;也可手动执行。
# 策略:下载 → 解压到新目录 → 保留 .env → 原子换目录 → 重启 → 健康检查 → 失败回滚。
set -u

REPO="liuxue5213/Maozi-Notebook"
API="https://api.github.com/repos/${REPO}/releases/tags/pi-latest"
APP_DIR=/opt/ledgerone
STAMP="${APP_DIR}/DEPLOY_VERSION"
WORK=/tmp/ledgerone-deploy
LOG_TAG="[autodeploy]"

log() { echo "$LOG_TAG $(date '+%F %T') $*"; }

json_asset_url() { python3 -c "import json,sys; d=json.load(sys.stdin); print(next(a['browser_download_url'] for a in d['assets'] if a['name']=='$1'))"; }

# 1) 取远端版本
REMOTE_VER=$(curl -fsSL --max-time 20 "$API" | json_asset_url VERSION | xargs -r curl -fsSL --max-time 20) || { log "GitHub 不可达,跳过本轮"; exit 0; }
[ -n "$REMOTE_VER" ] || { log "远端版本为空,跳过"; exit 0; }
LOCAL_VER=$(cat "$STAMP" 2>/dev/null || echo "none")
if [ "$REMOTE_VER" = "$LOCAL_VER" ]; then exit 0; fi
log "发现新版本 $REMOTE_VER(本地 $LOCAL_VER),开始部署"

# 2) 下载解压
rm -rf "$WORK"; mkdir -p "$WORK"
TARBALL=$(curl -fsSL --max-time 30 "$API" | json_asset_url server-deploy.tar.gz)
# 国内直连 GitHub release-assets(Azure CDN)易断流:重试+断点续传
ok=0
for i in $(seq 1 8); do
  curl -fSL --retry 3 --retry-all-errors -C - --max-time 600 -o "$WORK/pkg.tar.gz" "$TARBALL" && ok=1 && break
  log "下载重试 $i"; sleep 5
done
[ "$ok" = 1 ] || { log "下载失败"; exit 1; }
gzip -t "$WORK/pkg.tar.gz" 2>/dev/null || { log "gzip 校验失败"; rm -f "$WORK/pkg.tar.gz"; exit 1; }
tar xzf "$WORK/pkg.tar.gz" -C "$WORK" || { log "解压失败"; rm -rf "$WORK"; exit 1; }
[ -d "$WORK/pi-deploy/dist" ] || { log "包结构异常(缺 dist)"; exit 1; }

# 3) 保留配置,原子切换
cp -a "$APP_DIR/.env" "$WORK/pi-deploy/.env" 2>/dev/null || log "警告:无 .env,新包将用默认配置"
echo "$REMOTE_VER" > "$WORK/pi-deploy/DEPLOY_VERSION"
OLD="${APP_DIR}_old"
rm -rf "$OLD"; mv "$APP_DIR" "$OLD" && mv "$WORK/pi-deploy" "$APP_DIR" || { log "目录切换失败"; exit 1; }

# 4) 重启 + 健康检查(最多 60s),失败回滚
systemctl restart ledgerone
for i in $(seq 1 12); do
  sleep 5
  if curl -fsS --max-time 3 http://127.0.0.1:60505/healthz >/dev/null 2>&1; then
    log "部署成功:$REMOTE_VER"
    systemctl is-active --quiet ledgerone || true
    exit 0
  fi
done
log "健康检查失败,回滚到 $LOCAL_VER"
rm -rf "$APP_DIR" && mv "$OLD" "$APP_DIR"
systemctl restart ledgerone
exit 1

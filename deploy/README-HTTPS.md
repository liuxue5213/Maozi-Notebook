# T-05 · HTTPS 上线指引(树莓派 + frp 拓扑)

> 目标:把移动端/Web 与服务端之间的 token 与账目数据从公网明文 HTTP 切换为 TLS 加密。
> 预计耗时:域名就绪后约 30 分钟;frp 隧道无需改动(TCP 透传,TLS 端到端)。

## 前置条件(对应需求文档 Q5/Q11)

| 项 | 说明 |
|---|---|
| 域名 | 一个即可(如 `ledger.example.com`),A 记录 → `43.138.212.106` |
| 证书 | Let's Encrypt 免费;用 **DNS 验证**签发(公网 55505 已被 frp 占用,HTTP-01 走不通) |
| 客户端 | 移动端预设改为 `https://` 后重新出包(GitHub Actions) |

## 一、签发证书(树莓派上执行)

```bash
sudo apt install certbot
# DNS 验证:certbot 会给一条 TXT 记录,去域名解析后台添加后回车
sudo certbot certonly --manual --preferred-challenges dns \
  -d ledger.example.com
# 产物:/etc/letsencrypt/live/ledger.example.com/{fullchain,privkey}.pem
```

> 若域名解析托管在支持 API 的服务商(阿里云/Cloudflare),可装对应 certbot 插件
> (`certbot-dns-aliyun` 等)实现自动续期,免每 90 天手动跑一次。

## 二、nginx 切换

1. 把 `deploy/nginx-https.conf.example` 中的 `<你的域名>` 全部替换为实际域名;
2. 按文件内注释确认后端实际端口(`proxy_pass` 指向 nestjs 监听地址);
3. 覆盖对应 server 块并生效:

```bash
sudo nginx -t && sudo systemctl reload nginx
# 验证(在任意外网机器):
curl -v https://ledger.example.com:55505/healthz
```

## 三、客户端切换

| 端 | 动作 |
|---|---|
| 移动端 | `apps/mobile/src/lib/api.ts` 中 `DEFAULT_SERVER` 与 `SERVER_PRESETS` 的公网地址改为 `https://<域名>:55505`(文件内有标注行),出包发布 |
| Web | `apps/web` 的服务器地址是用户可配的,登录页高级设置里填 https 地址即可 |

移动端已内置的配套防护(本次随 T-05 落地,无需额外配置):

- `validateServerUrl`:协议白名单,仅接受 http(s),非法地址在登录前即拒绝;
- `insecureTransportReason`:公网地址走 http 时,「我的」页服务器输入框下方**常驻橙色告警**;局域网/回环地址豁免。

## 四、迁移与回滚(RK-05 对应)

- **旧版本 App**:切换 nginx 为 TLS 后,旧客户端(明文)会连不上 → 故障转移链自动落到局域网预设;
- **兜底**:nginx 模板自带 60506 明文 301 跳转方案(需 frp 加一条 55506→60506 转发),供过渡期使用;
- **回滚**:nginx reload 回原明文 server 块即恢复,无数据风险(同步协议本身不依赖传输层)。

## 五、HSTS 与加固时序

HTTPS 稳定运行 ≥1 周后,再打开模板中 `Strict-Transport-Security` 注释行并 reload——
HSTS 一旦下发无法短期撤销,必须最后开。

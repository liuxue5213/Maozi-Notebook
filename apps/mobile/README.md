# @ledgerone/mobile(Expo 骨架)

按 [技术选型决策 D05](../../技术选型决策.md),V1.0 实施顺序为 domain/sync → server → web → mobile。
本目录目前是**未安装的骨架**:文件齐全但不在 pnpm workspace 安装范围内。

启动 App 端开发:

1. 在根目录 `pnpm-workspace.yaml` 的 `packages` 中加入 `apps/mobile`;
2. 执行 `pnpm install`;
3. `pnpm --filter @ledgerone/mobile start`(需本机 Expo/移动端开发环境)。

技术要点(与 PRD 对齐):

- 本地库:expo-sqlite(内置 SQLCipher,打开库时传密钥)满足 M16-F02 整库加密;
- 业务逻辑与同步引擎直接复用 `@ledgerone/domain` / `@ledgerone/sync`,与 Web 端同一套代码;
- 后续页面按 PRD 4.2 P01–P20 展开。

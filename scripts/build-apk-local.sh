#!/usr/bin/env bash
# ============================================================================
# LedgerOne 本地 APK 构建(2026-10-08 起 APK 构建不经过 GitHub Actions)
#
# 用法:
#   scripts/build-apk-local.sh              # arm64 单架构 release(自用装机,~32MB)
#   scripts/build-apk-local.sh universal    # 全架构 release(分享给其他设备,~95MB)
#   scripts/build-apk-local.sh debug        # debug 变体(带全部日志,性能差,勿日常用)
#
# 前置(一次性,已就绪则跳过):
#   1. pnpm install(patches/expo-modules-core@57.0.19.patch 必须在——
#      expo gradle 插件 Kotlin 2.1.20 读不了 autolinking jar 的 2.3.0 元数据)
#   2. apps/mobile/android/local.properties 指向本机 SDK(如 sdk.dir=/Users/xxx/android-sdk)
#   3. JAVA:JDK 17+(本机当前用 JDK 23 可构建)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT="${1:-release}"
cd apps/mobile/android

case "$VARIANT" in
  release)
    ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
    OUT=app/build/outputs/apk/release/app-release.apk
    ;;
  universal)
    ./gradlew assembleRelease --console=plain
    OUT=app/build/outputs/apk/release/app-release.apk
    ;;
  debug)
    ./gradlew assembleDebug --console=plain
    OUT=app/build/outputs/apk/debug/app-debug.apk
    ;;
  *) echo "用法: $0 [release|universal|debug]"; exit 1;;
esac

echo "── 构建完成: $(pwd)/$OUT"
ls -lh "$OUT" | awk '{print "   大小: " $5}'
echo "安装: adb install -r $OUT"
echo "传输不稳定时用分块: split -b 4m <apk> /tmp/p. && 逐块 adb shell 'cat > /data/local/tmp/…' 后 cat 合并 + md5 校验 + pm install -r"

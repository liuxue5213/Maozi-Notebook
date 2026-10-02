#!/usr/bin/env python3
"""裁剪 pnpm deploy 产物:剔除与服务端运行时无关的重型依赖树。

drizzle-orm 的 peer 声明会把 Expo/React-Native 整条移动端工具链(~330MB)
拖进服务端部署包;服务端运行时只需要 mysql2/nestjs/express 等。
树莓派 3B 磁盘紧张,裁完 ~126MB(压缩 ~19MB)。
用法: prune-deploy.py <deploy_dir>
"""

import pathlib
import shutil
import sys

DROP_PREFIXES = (
    "expo", "react-native", "react-devtools", "fb-dotslash",
    "@expo", "@react-native", "@electric-sql", "hermes",
)


def main() -> None:
    root = pathlib.Path(sys.argv[1])
    pnpm = root / "node_modules" / ".pnpm"
    if not pnpm.is_dir():
        raise SystemExit(f"no .pnpm dir under {root}")
    freed = 0
    for d in pnpm.iterdir():
        name = d.name.split("@")[0] if d.name.startswith("@") else d.name
        if name.startswith(DROP_PREFIXES):
            freed += du(d)
            shutil.rmtree(d, ignore_errors=True)
    # 顶层符号链接里指向已删目标的也清掉
    for link in (root / "node_modules").iterdir():
        if link.is_symlink() and not link.resolve().exists():
            link.unlink()
    print(f"pruned ~{freed // (1024 * 1024)}MB from {root}")


def du(d: pathlib.Path) -> int:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())


if __name__ == "__main__":
    main()

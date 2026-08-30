#!/usr/bin/env python3
"""发布打包：跑多入口构建（node scripts/build.js），从 dist/ 组装 Chrome zip。

只支持 Chrome 单变体（ADR-0002）：Firefox 变体（sidebar_action 改写、
sidePanel 权限摘除、打包期对 options.css/validators.js 的字符串补丁）已随
Firefox 兼容整套删除。发布 zip 里是 dist/ 的 minified 产物，不是源码。
"""
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
DIST_DIR = ROOT / "dist"
RELEASE_DIR = ROOT / "release"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
PACKAGE_NAME = "bilibili-summary"


def load_manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_package_version():
    with (ROOT / "package.json").open("r", encoding="utf-8") as fh:
        return json.load(fh).get("version") or ""


def run_build():
    # 多入口构建 + dist/ 组装（content bootstrap/主包/chunk、其余入口 bundle
    # + minify、CSS minify、静态资源拷贝、manifest/html 引用校验、字节报表
    # 全部在 build.js 内完成）。
    subprocess.run(
        ["node", str(ROOT / "scripts" / "build.js")],
        cwd=ROOT,
        check=True,
    )


def build_zip(version: str):
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = DIST_DIR / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("dist/manifest.json is missing; run failed?")

    # dist 的 manifest 即发布 manifest（build.js 原样拷贝、零改写），再校验
    # 一次版本一致性，防止 dist 陈旧或构建中途被改。
    with manifest_path.open("r", encoding="utf-8") as fh:
        dist_manifest = json.load(fh)
    if str(dist_manifest.get("version") or "").strip() != version:
        raise SystemExit(
            f"Version mismatch: dist/manifest.json has \"version\": "
            f"{dist_manifest.get('version')!r}, expected {version!r}"
        )

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-chrome.zip"
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(DIST_DIR.rglob("*")):
            if file_path.is_dir():
                continue
            archive.write(file_path, file_path.relative_to(DIST_DIR))

    return zip_path


def main():
    manifest = load_manifest()
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise SystemExit("manifest.json is missing a version")

    # Version-consistency guard: the extension version lives in three places
    # (manifest.json, extension/core/version.js via build-content.js,
    # and package.json). Fail fast if package.json drifts from manifest.json
    # before stamping the release zip with a stale version.
    package_version = load_package_version().strip()
    if package_version != version:
        raise SystemExit(
            f"Version mismatch: manifest.json has \"version\": {version}, "
            f"but package.json has \"version\": {package_version!r}"
        )

    print("Building dist/ (multi-entry bundles + content packages + assets) ...", flush=True)
    run_build()

    zip_path = build_zip(version)

    print(f"Built release package for v{version} (chrome only):")
    print(f"- zip: {zip_path}")


if __name__ == "__main__":
    main()

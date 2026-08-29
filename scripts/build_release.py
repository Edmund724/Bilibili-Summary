#!/usr/bin/env python3
import json
import shutil
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
RELEASE_DIR = ROOT / "release"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
PACKAGE_NAME = "bilibili-summary"


def load_manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_package_version():
    with (ROOT / "package.json").open("r", encoding="utf-8") as fh:
        return json.load(fh).get("version") or ""


def dump_manifest(path: Path, data: dict):
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def prepare_release_dir(path: Path):
    if path.exists():
        shutil.rmtree(path)
    shutil.copytree(EXTENSION_DIR, path)


def disable_firefox_player_ai_quick_action(release_folder: Path):
    # After the directory restructure, options.css lives under pages/ and the
    # normalizeEnablePlayerAiQuickAction helper is defined in core/validators.js
    # (the service worker in entry/background.js only imports it). Targeting the
    # right files keeps the Firefox-only disable change from being silently skipped.
    options_css = release_folder / "pages" / "options.css"
    if options_css.exists():
        with options_css.open("a", encoding="utf-8") as fh:
            fh.write(
                "\n/* Firefox uses the built-in extension sidebar entry; hide the page-level AI quick button setting. */\n"
                ".player-ai-quick-action-settings { display: none !important; }\n"
            )

    validators_js = release_folder / "core" / "validators.js"
    if validators_js.exists():
        source = validators_js.read_text(encoding="utf-8")
        source = source.replace(
            "export function normalizeEnablePlayerAiQuickAction(value) {\n  return value === true;\n}",
            "export function normalizeEnablePlayerAiQuickAction(_value) {\n  return false;\n}",
        )
        validators_js.write_text(source, encoding="utf-8")


def build_variant(manifest: dict, browser: str, version: str):
    release_folder = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}"
    zip_path = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}.zip"

    prepare_release_dir(release_folder)

    variant_manifest = json.loads(json.dumps(manifest))
    if browser == "chrome":
        variant_manifest.pop("browser_specific_settings", None)
        variant_manifest.pop("sidebar_action", None)
        background = variant_manifest.setdefault("background", {})
        background.pop("scripts", None)
        background["service_worker"] = "entry/background.js"
    elif browser == "firefox":
        gecko = variant_manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
        gecko.setdefault("id", "bilibili-summary@github.com")
        gecko.setdefault("strict_min_version", "109.0")
        permissions = variant_manifest.get("permissions", [])
        if isinstance(permissions, list):
            variant_manifest["permissions"] = [item for item in permissions if item != "sidePanel"]
        variant_manifest.pop("side_panel", None)
        variant_manifest["sidebar_action"] = {
            "default_title": "Bilibili-Summary｜一键总结B站视频",
            "default_icon": {
                "16": "icons/icon16.png",
                "32": "icons/icon32.png",
                "48": "icons/icon48.png"
            },
            "default_panel": "pages/sidepanel.html",
            "open_at_install": False
        }
        background = variant_manifest.setdefault("background", {})
        background.pop("service_worker", None)
        background["scripts"] = ["entry/background.js"]
        disable_firefox_player_ai_quick_action(release_folder)
    else:
        raise ValueError(f"Unsupported browser: {browser}")

    dump_manifest(release_folder / "manifest.json", variant_manifest)

    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(release_folder.rglob("*")):
            if file_path.is_dir():
                continue
            archive.write(file_path, file_path.relative_to(release_folder))

    return release_folder, zip_path


def main():
    manifest = load_manifest()
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise SystemExit("manifest.json is missing a version")

    # Version-consistency guard: the extension version lives in three places
    # (manifest.json, extension/core/version.js via build-content.js,
    # and package.json). Fail fast if package.json drifts from manifest.json
    # before stamping release folders with a stale version.
    package_version = load_package_version().strip()
    if package_version != version:
        raise SystemExit(
            f"Version mismatch: manifest.json has \"version\": {version}, "
            f"but package.json has \"version\": {package_version!r}"
        )

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)

    # Rebuild the content script output (classic bootstrap + ESM main package
    # + dynamic chunks) through the esbuild build before build_variant() copies
    # the extension dir into release variants. copytree 整目录拷贝，chunks/ 下的
    # 动态 chunk 因此天然随包分发。
    print("Building content script bundles (bootstrap + main + chunks) ...", flush=True)
    subprocess.run(
        ["node", str(ROOT / "scripts" / "build-content.js")],
        cwd=ROOT,
        check=True,
    )

    built = [
        build_variant(manifest, "chrome", version),
        build_variant(manifest, "firefox", version),
    ]

    print(f"Built release packages for v{version}:")
    for folder, zip_path in built:
        print(f"- dir: {folder}")
        print(f"  zip: {zip_path}")


if __name__ == "__main__":
    main()

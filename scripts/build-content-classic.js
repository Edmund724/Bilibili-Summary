const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { build } = require("esbuild");

const entry = path.join(__dirname, "..", "extension", "content.js");
const outfile = path.join(__dirname, "..", "extension", "content-classic.js");

// Version-consistency guard: fail fast before invoking esbuild if the
// BOC_VERSION literal in extension/version.js drifts from manifest.json's
// "version". This guards the runtime probe that compares
// __BOC_CONTENT_SCRIPT_LOADED__ against chrome.runtime.getManifest().version.
const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
const versionJsPath = path.join(__dirname, "..", "extension", "version.js");

const manifestVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
const versionJsText = fs.readFileSync(versionJsPath, "utf8");
const versionJsMatch = /export const BOC_VERSION = "([^"]+)"/.exec(versionJsText);
const versionJsVersion = versionJsMatch ? versionJsMatch[1] : null;

if (!versionJsVersion || versionJsVersion !== manifestVersion) {
  console.error(
    `Version mismatch: ${manifestPath} has "version": ${manifestVersion}, ` +
      `but ${versionJsPath} declares BOC_VERSION = ${versionJsVersion ?? "(unparseable)"}`
  );
  process.exit(1);
}

const minify = process.env.BOC_MINIFY !== "0";
const REQUIRED_MARKER = "__BOC_CONTENT_SCRIPT_LOADED__";

build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  minify,
})
  .then(() => {
    // Grammar check: the IIFE output is a classic script, so `node --check`
    // accepts it. A non-zero result throws and falls through to the catch
    // handler, failing the build with a non-zero exit.
    execFileSync(process.execPath, ["--check", outfile], { stdio: "inherit" });

    // Marker assertion: the bundle must expose the content-script sentinel.
    const outputText = fs.readFileSync(outfile, "utf8");
    if (!outputText.includes(REQUIRED_MARKER)) {
      console.error(
        `Self-check failed: ${outfile} is missing required marker ${REQUIRED_MARKER}`
      );
      process.exitCode = 1;
      return;
    }

    // Size report.
    const sizeInBytes = fs.statSync(outfile).size;
    console.log(`Wrote ${outfile} (minified: ${minify}, ${sizeInBytes} bytes)`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
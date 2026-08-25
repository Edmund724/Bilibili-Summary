const path = require("path");
const { build } = require("esbuild");

const entry = path.join(__dirname, "..", "extension", "content.js");
const outfile = path.join(__dirname, "..", "extension", "content-classic.js");

const minify = process.env.BOC_MINIFY !== "0";

build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  minify,
})
  .then(() => {
    console.log(`Wrote ${outfile} (minified: ${minify})`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
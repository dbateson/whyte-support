// Builds the embeddable web components into public/embed/ (run before next build).
// The design system's CSS is inlined for the shadow root with :root rewritten to
// :host; its @font-face rules are kept apart, to be registered on the host page.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ds = join(root, "node_modules/@whyte/design-system");
const out = join(root, "public/embed");

async function inlineCss(file) {
  const css = await readFile(file, "utf8");
  const parts = await Promise.all(
    css.split("\n").map(async (line) => {
      const m = /^@import\s+"(.+)";/.exec(line.trim());
      return m ? inlineCss(join(dirname(file), m[1])) : line;
    }),
  );
  return parts.join("\n");
}

const full = await inlineCss(join(ds, "styles.css"));
const fontFaces = (full.match(/@font-face\s*\{[^}]*\}/g) ?? []).map((f) => f.replace(/url\('\.\.\/fonts\//g, "url('__FONT_BASE__/")).join("\n");
const scoped = full
  .replace(/@font-face\s*\{[^}]*\}/g, "")
  .replace(/:root(?![\w-])/g, ":host")
  // The design system sets no base styles; give the form its body text and box model.
  .concat("\n:host{display:block;color:var(--color-text);font-family:var(--font-sans)}\n:host *,:host *::before,:host *::after{box-sizing:border-box}\n");

await mkdir(join(out, "fonts"), { recursive: true });
for (const f of await readdir(join(ds, "fonts"))) {
  if (f.endsWith(".woff2")) await copyFile(join(ds, "fonts", f), join(out, "fonts", f));
}

const cssPlugin = {
  name: "embed-css",
  setup(b) {
    b.onResolve({ filter: /^embed-css$/ }, () => ({ path: "embed-css", namespace: "embed-css" }));
    b.onLoad({ filter: /.*/, namespace: "embed-css" }, () => ({
      contents: `export const EMBED_CSS = ${JSON.stringify(scoped)};\nexport const FONT_FACES = ${JSON.stringify(fontFaces)};`,
      loader: "js",
    }));
  },
};

const common = {
  bundle: true,
  format: "iife",
  minify: true,
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@": join(root, "src") },
  plugins: [cssPlugin],
  legalComments: "none",
  logLevel: "warning",
};
const entries = {
  "support-form": "src/embed/support-form.tsx",
  // A small loader, and the chat it fetches once the host page is idle.
  "support-chat": "src/embed/support-chat.ts",
  "support-chat-app": "src/embed/support-chat-app.tsx",
};
for (const [name, entry] of Object.entries(entries)) {
  await build({ ...common, entryPoints: [join(root, entry)], outfile: join(out, `${name}.js`) });
}
console.log(`build-embed: wrote ${Object.keys(entries).map((n) => `public/embed/${n}.js`).join(", ")}`);

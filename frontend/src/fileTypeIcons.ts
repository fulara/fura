const DEFAULT_FILE_ICON = "⌘";

const FILE_TYPE_ICONS: Record<string, string> = {
  typescript: "🟦",
  ts: "🟦",
  tsx: "🟦",
  mts: "🟦",
  cts: "🟦",
  javascript: "🟨",
  js: "🟨",
  jsx: "🟨",
  mjs: "🟨",
  cjs: "🟨",
  python: "🐍",
  py: "🐍",
  pyi: "🐍",
  rust: "🦀",
  rs: "🦀",
  go: "🐹",
  java: "☕",
  c: "Ⓒ",
  h: "Ⓒ",
  cpp: "➕",
  "c++": "➕",
  cc: "➕",
  cxx: "➕",
  hh: "➕",
  hpp: "➕",
  hxx: "➕",
  csharp: "♯",
  cs: "♯",
  ruby: "💎",
  rb: "💎",
  php: "🐘",
  swift: "🕊",
  kotlin: "🅺",
  kt: "🅺",
  bash: "💻",
  sh: "💻",
  zsh: "💻",
  fish: "💻",
  powershell: "💻",
  just: "💻",
  shell: "💻",
  html: "🌐",
  htm: "🌐",
  astro: "🌐",
  vue: "🌐",
  svelte: "🌐",
  css: "🎨",
  scss: "🎨",
  sass: "🎨",
  less: "🎨",
  json: "🧾",
  jsonc: "🧾",
  yaml: "📋",
  yml: "📋",
  markdown: "📝",
  md: "📝",
  mdx: "📝",
  sql: "🗄",
  dockerfile: "🐳",
  docker: "🐳",
  containerfile: "🐳",
  lua: "🌙",
  text: "🗒",
  txt: "🗒",
  plain: "🗒",
  env: "🔧",
  dotenv: "🔧",
  toml: "🧾",
  xml: "⟨⟩",
  ini: "⚙",
  conf: "⚙",
  cfg: "⚙",
  config: "⚙",
  properties: "⚙",
  gitignore: "⚙",
  gitattributes: "⚙",
  gitmodules: "⚙",
  editorconfig: "⚙",
  npmrc: "⚙",
  prettierrc: "⚙",
  eslintrc: "⚙",
  prettierignore: "⚙",
  eslintignore: "⚙",
  log: "📜",
  csv: "📑",
  tsv: "📑",
  image: "🖼",
  img: "🖼",
  png: "🖼",
  jpg: "🖼",
  jpeg: "🖼",
  gif: "🖼",
  webp: "🖼",
  svg: "🖼",
  ico: "🖼",
  bmp: "🖼",
  tiff: "🖼",
  pdf: "📕",
  archive: "🗜",
  zip: "🗜",
  tar: "🗜",
  gz: "🗜",
  tgz: "🗜",
  bz2: "🗜",
  xz: "🗜",
  "7z": "🗜",
  binary: "⚙",
  exe: "⚙",
  dll: "⚙",
  so: "⚙",
  dylib: "⚙",
  wasm: "⚙",
  bin: "⚙",
};

export function fileTypeIcon(filePath: string | undefined): string {
  if (!filePath?.trim()) return DEFAULT_FILE_ICON;
  const normalizedPath = filePath.trim().toLowerCase();
  const baseName = normalizedPath.slice(Math.max(normalizedPath.lastIndexOf("/"), normalizedPath.lastIndexOf("\\")) + 1);

  if (baseName.startsWith(".env.")) return FILE_TYPE_ICONS.env;
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.")) return FILE_TYPE_ICONS.dockerfile;
  if (baseName === "containerfile" || baseName.startsWith("containerfile.")) return FILE_TYPE_ICONS.containerfile;
  if (baseName === "justfile") return FILE_TYPE_ICONS.just;
  if (baseName === "cmakelists.txt") return FILE_TYPE_ICONS.conf;

  const extensionKey = extensionSegment(normalizedPath) ?? baseName;
  return FILE_TYPE_ICONS[extensionKey] ?? DEFAULT_FILE_ICON;
}

export function filePathWithIcon(filePath: string | undefined, formatPath: (path: string) => string = path => path): string {
  if (!filePath?.trim()) return "…";
  return `${fileTypeIcon(filePath)} ${formatPath(filePath)}`;
}

function extensionSegment(filePath: string): string | undefined {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return dot > lastSlash ? filePath.slice(dot + 1) : undefined;
}

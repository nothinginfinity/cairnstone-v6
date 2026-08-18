export const REPO_STONES_OPERATION_VERSION = "0.2.4";

export function canonicalChain(owner, repo, override) {
  if (typeof override === "string" && override.trim()) return override.trim();
  return `${owner}/${repo}`;
}

export const DEFAULT_REPO_STONE_EXTENSIONS = [
  ".md", ".mdx", ".txt", ".rst", ".adoc",
  ".json", ".jsonc", ".toml", ".yml", ".yaml", ".ini", ".cfg", ".conf",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm", ".vue", ".svelte",
  ".rs", ".go", ".java", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  ".cs", ".php", ".rb", ".lua", ".swift", ".kt", ".kts", ".scala",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".py", ".pyw", ".r", ".R",
  ".sql", ".graphql", ".gql", ".proto",
  ".tf", ".hcl", ".dockerfile", ".mod", ".sum",
  ".env.example", ".editorconfig", ".gitignore", ".gitattributes", ".dockerignore",
  ".npmignore", ".eslintrc", ".prettierrc", ".babelrc", ".clang-format", ".clang-tidy",
];

export const REPO_STONE_EXACT_NAMES = new Set([
  "dockerfile", "makefile", "procfile", "justfile", "gemfile", "rakefile",
  "requirements.txt", "package.json", "cargo.toml", "wrangler.toml",
  "go.mod", "go.sum", "pyproject.toml", "setup.cfg", "setup.py",
  "pipfile", "poetry.lock",
  ".gitignore", ".dockerignore", ".gitattributes", ".editorconfig",
  ".npmignore", ".eslintrc", ".prettierrc", ".babelrc",
  ".clang-format", ".clang-tidy", ".env.example",
  ".travis.yml", "tox.ini", ".flake8",
]);

export const REPO_STONE_NAME_PREFIXES = [
  "readme", "license", "licence", "contributing", "changelog",
  "authors", "notice", "copying", "security", "codeowners",
  "maintainers", "support", "funding",
];

export const DEFAULT_REPO_STONE_IGNORES = [
  ".git/",
  "node_modules/", "vendor/",
  "dist/", "build/", "out/", "target/",
  "__pycache__/", ".pycache/", "pycache/",
  ".venv/", "venv/", ".env/", "env/",
  "coverage/", ".nyc_output/",
  ".wrangler/", ".next/", ".nuxt/", ".vercel/", ".turbo/", ".cache/",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", ".DS_Store",
];

const BINARY_REJECT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
  ".bmp", ".tiff", ".tif", ".heic", ".heif",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
  ".whl", ".egg", ".pyc", ".pyo",
  ".pt", ".pth", ".onnx", ".bin", ".safetensors", ".ckpt", ".pkl",
  ".pickle", ".npy", ".npz", ".h5", ".hdf5", ".pb",
  ".so", ".dylib", ".dll", ".exe", ".a", ".o", ".obj",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".sqlite3",
]);

function repoStonePathMatches(path, pattern) {
  const textPath = String(path || "").replace(/^\/+/, "");
  const rawPattern = String(pattern || "").trim().replace(/^\/+/, "");
  if (!textPath || !rawPattern) return false;
  if (textPath === rawPattern) return true;

  const normalizedPattern = rawPattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern.startsWith(".") && !normalizedPattern.includes("*") && !normalizedPattern.includes("/")) {
    return textPath.endsWith(normalizedPattern);
  }
  if (!normalizedPattern.includes("*")) return textPath.endsWith(normalizedPattern);

  if (!normalizedPattern.includes("/")) {
    if (textPath.includes("/")) return false;
    const basename = textPath.split("/").pop();
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(basename);
  }

  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(textPath);
}

export function repoStoneShouldInclude(path, size, options = {}) {
  const textPath = String(path || "");
  const maxFileBytes = Number(options.max_file_bytes || options.maxFileBytes || 900000);
  const extraIgnore = Array.isArray(options.exclude) ? options.exclude.map(String) : [];
  const ignored = [...DEFAULT_REPO_STONE_IGNORES, ...extraIgnore];
  if (!textPath || Number(size || 0) <= 0) return false;
  if (Number(size || 0) > maxFileBytes) return false;
  if (ignored.some((fragment) => textPath.includes(fragment))) return false;

  const basename = textPath.split("/").pop();
  const basenameLower = basename.toLowerCase();
  const dotIdx = basename.lastIndexOf(".");
  const ext = dotIdx > 0 ? basename.slice(dotIdx).toLowerCase() : "";
  if (ext && BINARY_REJECT_EXTENSIONS.has(ext)) return false;

  if (Array.isArray(options.include) && options.include.length > 0) {
    return options.include.map(String).some((pattern) => repoStonePathMatches(textPath, pattern));
  }
  if (REPO_STONE_EXACT_NAMES.has(basenameLower)) return true;
  if (REPO_STONE_NAME_PREFIXES.some((prefix) => basenameLower.startsWith(prefix))) return true;
  if (ext && DEFAULT_REPO_STONE_EXTENSIONS.includes(ext)) return true;
  return false;
}

export function detectLanguageFromPath(path) {
  const ext = String(path || "").split(".").pop().toLowerCase();
  const MAP = {
    py: "Python", pyw: "Python",
    js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
    ts: "TypeScript", tsx: "TypeScript",
    rs: "Rust", go: "Go", java: "Java",
    c: "C", cpp: "C++", cc: "C++", cxx: "C++", h: "C/C++", hpp: "C++",
    cs: "C#", php: "PHP", rb: "Ruby", lua: "Lua",
    sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell", ps1: "PowerShell",
    r: "R", R: "R", scala: "Scala", kt: "Kotlin", kts: "Kotlin", swift: "Swift",
    sql: "SQL", graphql: "GraphQL", gql: "GraphQL", proto: "Protobuf",
    html: "HTML", htm: "HTML", css: "CSS", vue: "Vue", svelte: "Svelte",
    md: "Markdown", mdx: "MDX", rst: "reStructuredText", adoc: "AsciiDoc",
    yaml: "YAML", yml: "YAML", toml: "TOML", json: "JSON", jsonc: "JSON",
    tf: "Terraform", hcl: "HCL",
  };
  return MAP[ext] || null;
}

export function buildLanguageBreakdown(files = []) {
  const byLang = new Map();
  let totalBytes = 0;
  for (const file of files || []) {
    const lang = detectLanguageFromPath(file.path) || "Other";
    const bytes = Number(file.size || file.bytes || 0);
    const current = byLang.get(lang) || { lang, file_count: 0, bytes: 0 };
    current.file_count += 1;
    current.bytes += bytes;
    totalBytes += bytes;
    byLang.set(lang, current);
  }
  return Array.from(byLang.values())
    .map((item) => ({ ...item, pct_bytes: totalBytes > 0 ? Number(((item.bytes / totalBytes) * 100).toFixed(2)) : 0 }))
    .sort((a, b) => b.file_count - a.file_count || b.bytes - a.bytes || a.lang.localeCompare(b.lang));
}

export function buildRepoFingerprint({ owner, repo, ref, headCommit, treeHash, languages, frameworks, configs, stoneCount, fileCount, compressionRatio }) {
  return {
    repo: `${owner}/${repo}`,
    default_branch: ref,
    head_commit: headCommit || null,
    tree_hash: treeHash || null,
    languages: languages || [],
    major_frameworks: frameworks || [],
    major_configs: configs || [],
    stone_count: stoneCount || 0,
    file_count: fileCount || 0,
    compression_ratio: compressionRatio || 0,
    generated_at: new Date().toISOString(),
  };
}

export function detectArchitecture(files = []) {
  const paths = files.map((f) => f.path || "");
  const entryPoints = paths.filter((p) => {
    const b = p.split("/").pop().toLowerCase();
    return [
      "main.py", "app.py", "index.js", "index.ts", "main.js", "main.ts",
      "main.go", "main.rs", "main.c", "main.cpp", "app.js", "app.ts",
      "server.js", "server.ts", "worker.js", "worker.ts",
    ].includes(b);
  });
  const apiFiles = paths.filter((p) => /\/api\/|\/routes?\/|\/handlers?\/|\/endpoints?\/|\/controllers?\/|\/views?\//i.test(p));
  const workerRoutes = paths.filter((p) =>
    p.includes("wrangler.toml") || p.includes("worker.js") || p.includes("worker.ts") || p.includes("_worker.js") || p.includes("/workers/") || p.includes("\\workers\\")
  );
  const cliFiles = paths.filter((p) => /cli\.js|cli\.ts|bin\/|scripts\/|cmd\//i.test(p));
  const configFiles = paths.filter((p) => /package\.json|wrangler\.toml|tsconfig\.json|vite\.config|next\.config|pyproject\.toml|cargo\.toml|go\.mod|dockerfile/i.test(p));
  const langSet = new Set(files.map((f) => detectLanguageFromPath(f.path)).filter(Boolean));
  return {
    languages: Array.from(langSet),
    frameworks: inferFrameworks(paths),
    configs: configFiles,
    entry_points: entryPoints,
    api_files: apiFiles,
    worker_routes: workerRoutes,
    cli_files: cliFiles,
    has_entry_points: entryPoints.length > 0,
    has_api_routes: apiFiles.length > 0,
    has_worker_routes: workerRoutes.length > 0,
    has_cli: cliFiles.length > 0,
    estimated_pattern: inferPattern(entryPoints, apiFiles, workerRoutes, cliFiles),
  };
}

function inferPattern(entryPoints, apiFiles, workerRoutes, cliFiles) {
  if (workerRoutes.length > 0) return "cloudflare-worker";
  if (apiFiles.length > 0 && entryPoints.length > 0) return "rest-api";
  if (cliFiles.length > 0) return "cli-tool";
  if (entryPoints.length > 0) return "application";
  return "library";
}

function inferFrameworks(paths) {
  const joined = paths.join("\n").toLowerCase();
  const frameworks = [];
  if (joined.includes("wrangler.toml") || joined.includes("/workers/")) frameworks.push("Cloudflare Workers");
  if (joined.includes("next.config")) frameworks.push("Next.js");
  if (joined.includes("vite.config")) frameworks.push("Vite");
  if (joined.includes("package.json")) frameworks.push("Node.js");
  if (joined.includes("pyproject.toml") || joined.includes("requirements.txt")) frameworks.push("Python");
  if (joined.includes("cargo.toml")) frameworks.push("Rust/Cargo");
  if (joined.includes("go.mod")) frameworks.push("Go modules");
  return frameworks;
}

export function buildRepoOrientationContent({ owner, repo, ref, chain, created, reused, updated, skipped, failed, architecture, language_breakdown, fingerprint }) {
  const lines = [];
  lines.push(`# ${owner}/${repo} Repository Orientation`);
  lines.push(`**Chain:** \`${chain}\`  **Branch:** \`${ref}\``);
  lines.push("");
  if (fingerprint) {
    lines.push("## Fingerprint");
    lines.push(`- Pattern: ${architecture?.estimated_pattern || "unknown"}`);
    lines.push(`- Languages: ${(fingerprint.languages || []).join(", ") || "unknown"}`);
    lines.push(`- Files: ${fingerprint.file_count || 0}`);
    lines.push(`- Stones: ${fingerprint.stone_count || 0}`);
    lines.push("");
  }
  if (language_breakdown?.length) {
    lines.push("## Language Breakdown");
    language_breakdown.forEach((item) => lines.push(`- ${item.lang}: ${item.file_count} files, ${item.bytes} bytes`));
    lines.push("");
  }
  if (created?.length) {
    lines.push("## Created Stones");
    created.forEach(({ path, stone_hash }) => lines.push(`- ${path} -> ${String(stone_hash || "").slice(0, 12)}`));
    lines.push("");
  }
  if (reused?.length) {
    lines.push("## Reused Stones");
    reused.forEach(({ path, stone_hash }) => lines.push(`- ${path} -> ${String(stone_hash || "").slice(0, 12)}`));
    lines.push("");
  }
  if (updated?.length) {
    lines.push("## Updated Stones");
    updated.forEach(({ path, stone_hash, previous_stone_hash }) => lines.push(`- ${path}: ${String(previous_stone_hash || "").slice(0, 12)} -> ${String(stone_hash || "").slice(0, 12)}`));
    lines.push("");
  }
  if (skipped?.length) {
    lines.push("## Skipped Files");
    skipped.forEach(({ path, reason }) => lines.push(`- ${path}: ${reason}`));
    lines.push("");
  }
  if (failed?.length) {
    lines.push("## Failed Stones");
    failed.forEach(({ path, error }) => lines.push(`- ${path}: ${error}`));
    lines.push("");
  }
  lines.push("---");
  lines.push(`_Generated at ${new Date().toISOString()}_`);
  return lines.join("\n");
}

export function buildArchitectureContent(summary = {}, arch = summary.architecture || {}) {
  const lines = [];
  lines.push(`# ${summary.owner}/${summary.repo} Architecture`);
  lines.push(`**Chain:** \`${summary.chain}\`  **Branch:** \`${summary.ref}\``);
  lines.push("");
  lines.push("## Detected Pattern");
  lines.push(`- ${arch.estimated_pattern || "unknown"}`);
  lines.push("");
  lines.push("## Signals");
  lines.push(`- Entry points: ${arch.has_entry_points ? "yes" : "no"}`);
  lines.push(`- API routes: ${arch.has_api_routes ? "yes" : "no"}`);
  lines.push(`- Worker routes: ${arch.has_worker_routes ? "yes" : "no"}`);
  lines.push(`- CLI: ${arch.has_cli ? "yes" : "no"}`);
  lines.push("");
  if (arch.languages?.length) lines.push(`## Languages\n${arch.languages.map((l) => `- ${l}`).join("\n")}`);
  if (arch.frameworks?.length) lines.push(`\n## Frameworks\n${arch.frameworks.map((f) => `- ${f}`).join("\n")}`);
  if (arch.configs?.length) lines.push(`\n## Configs\n${arch.configs.slice(0, 50).map((f) => `- ${f}`).join("\n")}`);
  lines.push("\n---");
  lines.push(`_Generated at ${new Date().toISOString()}_`);
  return lines.join("\n");
}

export function liteLintAnalysis(path, raw) {
  const text = String(raw || "");
  const observations = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();
    if (/TODO|FIXME|HACK/.test(line)) observations.push(obs("todo_comment", "maintainability", "suggestion", path, lineNum, trimmed.slice(0, 160)));
    if (line.length > 180) observations.push(obs("long_line", "readability", "suggestion", path, lineNum, `Line is ${line.length} characters`));
    if (/console\.(log|debug)\(/.test(line)) observations.push(obs("console_debug", "debugging", "suggestion", path, lineNum, trimmed.slice(0, 160)));
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) observations.push(obs("empty_catch", "reliability", "likely", path, lineNum, "Empty catch block"));
    if (/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/i.test(line)) observations.push(obs("hardcoded_secret", "security", "critical", path, lineNum, "Potential hardcoded secret"));
  });
  return observations;
}

export function reviewAnalysis(path, raw) {
  const text = String(raw || "");
  const observations = [...liteLintAnalysis(path, raw)];
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  if (lineCount > 800) observations.push(obs("large_file", "maintainability", "suggestion", path, 1, `File has ${lineCount} lines; consider splitting by responsibility`));
  if (/eval\s*\(/.test(text)) observations.push(obs("eval_usage", "security", "likely", path, 1, "eval() usage detected"));
  if (/new Function\s*\(/.test(text)) observations.push(obs("dynamic_function", "security", "likely", path, 1, "Dynamic Function constructor detected"));
  return observations;
}

function obs(flag, category, severity, ref_id, line_num, text) {
  return { flag, category, severity, ref_id, line_num, text };
}

export function observationTriageByStage(observations = []) {
  const byStage = {
    critical: { score: 100, items: [] },
    likely: { score: 65, items: [] },
    suggestion: { score: 20, items: [] },
    noise: { score: 0, items: [] },
  };
  observations.forEach((obsItem) => {
    const { flag, category, severity, text, ref_id, line_num } = obsItem;
    const item = { flag, category, ref_id, line_num, text };
    if (severity === "critical" || flag === "hardcoded_secret") byStage.critical.items.push(item);
    else if (severity === "likely" || flag === "empty_catch") byStage.likely.items.push(item);
    else if (severity === "suggestion" || ["todo_comment", "long_line", "var_usage", "console_debug", "large_file"].includes(flag)) byStage.suggestion.items.push(item);
    else byStage.noise.items.push(item);
  });
  return byStage;
}

export function buildLintReportContent({ owner, repo, ref, chain, observations, filePath, stone_hash }) {
  return buildSingleFileReviewContent("Lint Report", { owner, repo, ref, chain, observations, filePath, stone_hash });
}

export function buildLintContent(summary = {}, lintResults = []) {
  const lines = [];
  lines.push(`# ${summary.owner}/${summary.repo} Lint Report`);
  lines.push(`**Chain:** \`${summary.chain}\`  **Branch:** \`${summary.ref}\``);
  lines.push("");
  const issueCount = lintResults.reduce((n, item) => n + (item.errors?.length || 0), 0);
  lines.push(`## Summary`);
  lines.push(`- Files with observations: ${lintResults.length}`);
  lines.push(`- Total observations: ${issueCount}`);
  lines.push("");
  if (lintResults.length === 0) lines.push("No lint observations generated.");
  for (const item of lintResults) {
    lines.push(`## ${item.path}`);
    for (const error of item.errors || []) lines.push(`- \`${error.flag}\` @line ${error.line_num}: ${error.text}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`_Generated at ${new Date().toISOString()}_`);
  return lines.join("\n");
}

export function buildReviewContent(summary = {}, reviewResults = []) {
  const lines = [];
  lines.push(`# ${summary.owner}/${summary.repo} Code Review`);
  lines.push(`**Chain:** \`${summary.chain}\`  **Branch:** \`${summary.ref}\``);
  lines.push("");
  const observationCount = reviewResults.reduce((n, item) => n + (item.observations?.length || 0), 0);
  lines.push(`## Summary`);
  lines.push(`- Files with observations: ${reviewResults.length}`);
  lines.push(`- Total observations: ${observationCount}`);
  lines.push("");
  if (reviewResults.length === 0) lines.push("No review observations generated.");
  for (const item of reviewResults) {
    lines.push(`## ${item.path}`);
    for (const observation of item.observations || []) lines.push(`- \`${observation.flag}\` @line ${observation.line_num}: ${observation.text}`);
    lines.push("");
  }
  lines.push("## Disclaimer");
  lines.push("This review is generated automatically by static analysis. Human review is recommended before treating suggestions as bugs.");
  lines.push("---");
  lines.push(`_Generated at ${new Date().toISOString()}_`);
  return lines.join("\n");
}

function buildSingleFileReviewContent(title, { owner, repo, ref, chain, observations, filePath, stone_hash }) {
  const lines = [];
  lines.push(`# ${owner}/${repo} ${title}`);
  lines.push(`**Chain:** \`${chain}\`  **File:** \`${filePath}\`  **Ref:** \`${ref}\``);
  lines.push(`**Stone:** \`${stone_hash}\``);
  lines.push("");
  const triage = observationTriageByStage(observations || []);
  let total = 0;
  for (const [stage, { items }] of Object.entries(triage)) {
    if (items.length === 0) continue;
    total += items.length;
    lines.push(`## ${stage} (${items.length})`);
    items.forEach(({ flag, line_num, text }) => lines.push(`- \`${flag}\` @line ${line_num}: ${text}`));
    lines.push("");
  }
  if (total === 0) lines.push("No observations generated. The analyzed file appears clean.");
  lines.push("## Disclaimer");
  lines.push("This review is generated automatically by static analysis.");
  return lines.join("\n");
}

export function buildHealthDashboard({ chain, owner, repo, ref, langBreakdown, fileCount, stoneCount, refCount, compressionRatio, graphDensity, hasReview, hasLint, hasArchitecture, lastIndexedCommit, fingerprint }) {
  const langNames = (langBreakdown || []).map((l) => l.lang);
  const healthScore = computeHealthScore({ stoneCount, hasReview, hasLint, hasArchitecture, fileCount });
  return {
    chain,
    repo: `${owner}/${repo}`,
    ref,
    languages: langNames,
    file_count: fileCount || 0,
    stone_count: stoneCount || 0,
    ref_count: refCount || 0,
    compression_ratio: compressionRatio || 0,
    graph_density: graphDensity || 0,
    has_review_stone: Boolean(hasReview),
    has_lint_stone: Boolean(hasLint),
    has_architecture_stone: Boolean(hasArchitecture),
    last_indexed_commit: lastIndexedCommit || null,
    health_score: healthScore,
    fingerprint: fingerprint || null,
  };
}

function computeHealthScore({ stoneCount, hasReview, hasLint, hasArchitecture, fileCount }) {
  let score = 0;
  if (stoneCount > 0) score += 30;
  if (fileCount > 0 && stoneCount >= Math.min(fileCount, 5)) score += 20;
  if (hasArchitecture) score += 20;
  if (hasLint) score += 15;
  if (hasReview) score += 15;
  return score;
}

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".rs": "rust",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".cpp": "cpp",
  ".swift": "swift",
};

export function detectLanguagesFromPaths(paths: readonly string[]): string[] {
  const languages = new Set<string>();
  for (const filePath of paths) {
    const ext = path.extname(filePath).toLowerCase();
    const language = EXTENSION_LANGUAGE_MAP[ext];
    if (language) languages.add(language);
  }
  return [...languages].sort();
}

const NODE_FRAMEWORK_DEPENDENCIES = ["next", "express", "fastify", "react", "vue", "koa", "@nestjs/core"];

export async function detectFrameworksFromManifest(snapshotPath: string): Promise<string[]> {
  const frameworks: string[] = [];

  const pkgPath = path.join(snapshotPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of NODE_FRAMEWORK_DEPENDENCIES) {
        if (deps[dep]) frameworks.push(dep === "@nestjs/core" ? "nestjs" : dep);
      }
    } catch {
      // malformed package.json — not fatal to repository preparation
    }
  }

  if (existsSync(path.join(snapshotPath, "requirements.txt")) || existsSync(path.join(snapshotPath, "pyproject.toml"))) {
    frameworks.push("python-project");
  }
  if (existsSync(path.join(snapshotPath, "go.mod"))) {
    frameworks.push("go-module");
  }
  if (existsSync(path.join(snapshotPath, "Gemfile"))) {
    frameworks.push("ruby-project");
  }

  return frameworks;
}

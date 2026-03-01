import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import type { ImportGraphData } from "../types.js";

export class ImportGraphBuilder {
  private readonly repoPath: string;
  private readonly files: string[];
  private readonly fileSet: Set<string>;

  constructor(repoPath: string, trackedFiles: string[]) {
    this.repoPath = repoPath;
    // Only source files worth analyzing
    this.files = trackedFiles.filter((f) =>
      /\.(ts|tsx|js|jsx|mjs|java|py|go|rs)$/.test(f),
    );
    this.fileSet = new Set(trackedFiles);
  }

  build(): ImportGraphData {
    const adjacency = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const f of this.files) {
      if (!adjacency.has(f)) adjacency.set(f, new Set());
    }

    for (const file of this.files) {
      const imports = this.extractImports(file);
      const resolved = this.resolveImports(file, imports);
      const adj = adjacency.get(file);
      for (const target of resolved) {
        adj?.add(target);
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }

    const topByFanIn = [...inDegree.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([file, fanIn]) => ({ file, fanIn }));

    return { adjacency, inDegree, topByFanIn };
  }

  private extractImports(filePath: string): string[] {
    const fullPath = join(this.repoPath, filePath);
    if (!existsSync(fullPath)) return [];
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      return [];
    }
    // Only read first 200 lines for performance
    const lines = content.split("\n").slice(0, 200).join("\n");

    const ext = extname(filePath).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".tsx":
      case ".js":
      case ".jsx":
      case ".mjs":
        return this.extractTsJsImports(lines);
      case ".java":
        return this.extractJavaImports(lines);
      case ".py":
        return this.extractPythonImports(lines);
      case ".go":
        return this.extractGoImports(lines);
      case ".rs":
        return this.extractRustImports(lines);
      default:
        return [];
    }
  }

  private extractTsJsImports(content: string): string[] {
    const imports: string[] = [];
    const staticRe = /^import\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/gm;
    const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const re of [staticRe, dynamicRe, requireRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        if (m[1]) imports.push(m[1]);
      }
    }
    return imports;
  }

  private extractJavaImports(content: string): string[] {
    const imports: string[] = [];
    const re = /^import\s+(?:static\s+)?([\w.]+)\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    return imports;
  }

  private extractPythonImports(content: string): string[] {
    const imports: string[] = [];
    const fromRe = /^from\s+([\w.]+)\s+import/gm;
    const importRe = /^import\s+([\w.]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    while ((m = importRe.exec(content)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    return imports;
  }

  private extractGoImports(content: string): string[] {
    const imports: string[] = [];
    const blockRe = /import\s*\(([\s\S]*?)\)/g;
    const singleRe = /^import\s+"([^"]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const block = m[1] ?? "";
      for (const line of block.split("\n")) {
        const pkg = line.trim().match(/"([^"]+)"/)?.[1];
        if (pkg) imports.push(pkg);
      }
    }
    while ((m = singleRe.exec(content)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    return imports;
  }

  private extractRustImports(content: string): string[] {
    const imports: string[] = [];
    const re = /^use\s+([\w:]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    return imports;
  }

  private resolveImports(sourceFile: string, imports: string[]): string[] {
    const resolved: string[] = [];
    const sourceDir = dirname(sourceFile);

    for (const imp of imports) {
      // Only resolve relative imports for TS/JS
      if (imp.startsWith(".")) {
        const base = join(sourceDir, imp).replace(/\\/g, "/");
        // Try with various extensions
        for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
          const candidate = ext ? base + ext : base;
          // Strip .js extension that might be in the import (ESM convention)
          const withoutJs = candidate.replace(/\.js$/, ".ts");
          if (this.fileSet.has(candidate)) {
            resolved.push(candidate);
            break;
          }
          if (this.fileSet.has(withoutJs)) {
            resolved.push(withoutJs);
            break;
          }
          // Try index file
          const indexCandidate = join(base, `index${ext || ".ts"}`).replace(/\\/g, "/");
          if (this.fileSet.has(indexCandidate)) {
            resolved.push(indexCandidate);
            break;
          }
        }
        continue;
      }

      // Java: resolve package imports to file paths
      if (sourceFile.endsWith(".java")) {
        // com.example.Foo -> com/example/Foo.java
        const javaPath = imp.replace(/\./g, "/") + ".java";
        // Try with common source prefixes
        for (const prefix of ["src/main/java/", "src/", ""]) {
          const candidate = prefix + javaPath;
          if (this.fileSet.has(candidate)) {
            resolved.push(candidate);
            break;
          }
        }
        continue;
      }

      // Python: resolve dotted imports
      if (sourceFile.endsWith(".py")) {
        const pyPath = imp.replace(/\./g, "/");
        for (const suffix of [".py", "/__init__.py"]) {
          if (this.fileSet.has(pyPath + suffix)) {
            resolved.push(pyPath + suffix);
            break;
          }
        }
      }
    }
    return resolved;
  }
}

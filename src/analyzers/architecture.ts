import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectureInsight } from "../types.js";
import { GitReader } from "./git.js";

export class ArchitectureInferrer {
  private readonly files: string[];

  constructor(
    private readonly repoPath: string,
    private readonly languages: string[],
  ) {
    const git = new GitReader(repoPath);
    this.files = git.isGitRepo() ? git.getTrackedFiles() : [];
  }

  infer(): ArchitectureInsight {
    return {
      style: this.detectStyle(),
      entryPoints: this.detectEntryPoints(),
      layers: this.detectLayers(),
      keyModules: this.detectKeyModules(),
      databasePatterns: this.detectDatabasePatterns(),
      apiPatterns: this.detectAPIPatterns(),
      testStructure: this.detectTestStructure(),
      hasDockerfile: this.fileExists("Dockerfile"),
      hasInfraAsCode: this.detectInfraAsCode(),
    };
  }

  private detectStyle(): ArchitectureInsight["style"] {
    const hasPackages = this.dirExists("packages");
    const hasApps = this.dirExists("apps");
    const hasServices = this.dirExists("services");
    const hasWorkspaces =
      this.fileExists("pnpm-workspace.yaml") ||
      this.fileExists("lerna.json") ||
      this.fileExists("turbo.json") ||
      this.fileExists("nx.json");

    if ((hasPackages || hasApps) && hasWorkspaces) return "monorepo";
    if (hasPackages && hasApps) return "monorepo";
    if (hasServices) return "microservices";

    // Detect Java microservices: multiple pom.xml with docker-compose or service-registry
    const pomFiles = this.files.filter((f) => f.endsWith("/pom.xml") || f === "pom.xml");
    if (pomFiles.length >= 3) {
      const hasDockerCompose = this.files.some((f) => f.includes("docker-compose"));
      const hasServiceRegistry = this.files.some((f) =>
        f.includes("service-registry") || f.includes("eureka") || f.includes("cloud-gateway"),
      );
      if (hasDockerCompose || hasServiceRegistry) return "microservices";
    }

    // Library detection: no entry point, has index/lib export
    const hasSrcIndex =
      this.fileExists("src/index.ts") || this.fileExists("src/lib.rs");
    const hasNoServer = !this.files.some(
      (f) =>
        f.includes("server.") ||
        f.includes("app.") ||
        f.includes("main.") ||
        f.includes("manage.py"),
    );
    if (hasSrcIndex && hasNoServer) return "library";

    return "monolith";
  }

  private detectEntryPoints(): string[] {
    const candidates = [
      "src/index.ts",
      "src/index.js",
      "src/main.ts",
      "src/main.js",
      "src/app.ts",
      "src/app.js",
      "src/server.ts",
      "src/server.js",
      "index.ts",
      "index.js",
      "main.go",
      "cmd/main.go",
      "src/main.rs",
      "src/lib.rs",
      "manage.py",
      "app.py",
      "main.py",
      "Program.cs",
      "App.java",
    ];
    return candidates.filter((c) => this.fileExists(c));
  }

  private detectLayers(): string[] {
    const layerDirs = [
      "controllers",
      "routes",
      "handlers",
      "services",
      "repositories",
      "models",
      "entities",
      "domain",
      "infrastructure",
      "middleware",
      "utils",
      "helpers",
      "lib",
      "api",
      "pages",
      "views",
      "templates",
      "components",
    ];
    return layerDirs.filter(
      (dir) =>
        this.dirExists(dir) ||
        this.dirExists(`src/${dir}`) ||
        this.dirExists(`app/${dir}`),
    );
  }

  private detectKeyModules(): string[] {
    const topDirs = new Set<string>();
    for (const file of this.files) {
      const parts = file.split("/");
      if (parts.length > 1 && parts[0]) {
        topDirs.add(parts[0]);
      }
    }
    // Filter out non-module dirs
    const ignore = new Set([
      "node_modules",
      ".git",
      ".github",
      ".vscode",
      "dist",
      "build",
      "coverage",
      ".changeset",
    ]);
    return [...topDirs].filter((d) => !ignore.has(d) && !d.startsWith("."));
  }

  private detectDatabasePatterns(): string[] {
    const patterns: string[] = [];
    if (this.files.some((f) => f.includes("migration"))) patterns.push("migrations");
    if (this.fileExists("prisma/schema.prisma")) patterns.push("Prisma");
    if (this.files.some((f) => f.endsWith(".sql"))) patterns.push("raw SQL");
    if (this.fileExists("schema.graphql") || this.fileExists("schema.gql"))
      patterns.push("GraphQL schema");
    if (this.files.some((f) => f.includes("knex"))) patterns.push("Knex");
    if (this.files.some((f) => f.includes("alembic"))) patterns.push("Alembic");
    return patterns;
  }

  private detectAPIPatterns(): string[] {
    const patterns: string[] = [];
    if (
      this.files.some(
        (f) => f.includes("openapi") || f.includes("swagger"),
      )
    )
      patterns.push("REST/OpenAPI");
    if (this.files.some((f) => f.endsWith(".graphql") || f.endsWith(".gql")))
      patterns.push("GraphQL");
    if (this.files.some((f) => f.endsWith(".proto"))) patterns.push("gRPC");
    if (this.files.some((f) => f.includes("trpc"))) patterns.push("tRPC");
    if (
      this.files.some(
        (f) =>
          f.includes("routes") || f.includes("controllers") || f.includes("api/"),
      )
    )
      patterns.push("REST");
    return [...new Set(patterns)];
  }

  private detectTestStructure(): ArchitectureInsight["testStructure"] {
    const testPattern =
      /\.(test|spec)\.(ts|tsx|js|jsx)$|_test\.(go|py|rb)$|Test\.java$/;
    const testFiles = this.files.filter((f) => testPattern.test(f));
    if (testFiles.length === 0) return "none";

    let colocated = 0;
    let separate = 0;
    for (const f of testFiles) {
      if (
        f.startsWith("tests/") ||
        f.startsWith("test/") ||
        f.startsWith("__tests__/") ||
        f.startsWith("spec/")
      ) {
        separate++;
      } else {
        colocated++;
      }
    }

    if (colocated > 0 && separate > 0) return "mixed";
    return colocated > separate ? "colocated" : "separate-dir";
  }

  private detectInfraAsCode(): boolean {
    return (
      this.dirExists("terraform") ||
      this.dirExists("k8s") ||
      this.dirExists("helm") ||
      this.dirExists("pulumi") ||
      this.dirExists("cdk") ||
      this.fileExists("docker-compose.yml") ||
      this.fileExists("docker-compose.yaml")
    );
  }

  private fileExists(path: string): boolean {
    return existsSync(join(this.repoPath, path));
  }

  private dirExists(path: string): boolean {
    return this.files.some((f) => f.startsWith(`${path}/`));
  }
}

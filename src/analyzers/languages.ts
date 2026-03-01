import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { GitReader } from "./git.js";

interface FrameworkSignature {
  name: string;
  files?: string[];
  packageDeps?: string[];
  minScore: number;
}

const FRAMEWORK_SIGNATURES: FrameworkSignature[] = [
  { name: "Next.js", packageDeps: ["next"], minScore: 1 },
  { name: "React", packageDeps: ["react", "react-dom"], minScore: 2 },
  { name: "Vue", packageDeps: ["vue"], minScore: 1 },
  { name: "Angular", packageDeps: ["@angular/core"], minScore: 1 },
  { name: "Svelte", packageDeps: ["svelte"], minScore: 1 },
  { name: "Express", packageDeps: ["express"], minScore: 1 },
  { name: "Fastify", packageDeps: ["fastify"], minScore: 1 },
  { name: "NestJS", packageDeps: ["@nestjs/core"], minScore: 1 },
  { name: "Django", files: ["manage.py"], packageDeps: ["django"], minScore: 1 },
  { name: "FastAPI", packageDeps: ["fastapi"], minScore: 1 },
  { name: "Flask", packageDeps: ["flask"], minScore: 1 },
  { name: "Gin", packageDeps: ["github.com/gin-gonic/gin"], minScore: 1 },
  { name: "Fiber", packageDeps: ["github.com/gofiber/fiber"], minScore: 1 },
  { name: "Actix", packageDeps: ["actix-web"], minScore: 1 },
  { name: "Axum", packageDeps: ["axum"], minScore: 1 },
  { name: "Spring Boot", packageDeps: ["spring-boot"], minScore: 1 },
  { name: "Rails", files: ["Gemfile", "config/routes.rb"], minScore: 2 },
  { name: "Laravel", files: ["artisan"], packageDeps: ["laravel/framework"], minScore: 1 },
];

const TEST_FRAMEWORK_SIGNATURES: FrameworkSignature[] = [
  { name: "Jest", packageDeps: ["jest"], minScore: 1 },
  { name: "Vitest", packageDeps: ["vitest"], minScore: 1 },
  { name: "Mocha", packageDeps: ["mocha"], minScore: 1 },
  { name: "Pytest", packageDeps: ["pytest"], minScore: 1 },
  { name: "RSpec", packageDeps: ["rspec"], minScore: 1 },
  { name: "Go Test", files: ["go.mod"], minScore: 1 },
  { name: "Playwright", packageDeps: ["@playwright/test", "playwright"], minScore: 1 },
  { name: "Cypress", packageDeps: ["cypress"], minScore: 1 },
];

const BUILD_TOOL_SIGNATURES: FrameworkSignature[] = [
  { name: "Webpack", packageDeps: ["webpack"], minScore: 1 },
  { name: "Vite", packageDeps: ["vite"], minScore: 1 },
  { name: "Turbopack", packageDeps: ["turbopack"], minScore: 1 },
  { name: "esbuild", packageDeps: ["esbuild"], minScore: 1 },
  { name: "Rollup", packageDeps: ["rollup"], minScore: 1 },
  { name: "Gradle", files: ["build.gradle", "build.gradle.kts"], minScore: 1 },
  { name: "Maven", files: ["pom.xml"], minScore: 1 },
  { name: "Make", files: ["Makefile"], minScore: 1 },
  { name: "Cargo", files: ["Cargo.toml"], minScore: 1 },
];

const ORM_SIGNATURES: FrameworkSignature[] = [
  { name: "Prisma", packageDeps: ["prisma", "@prisma/client"], minScore: 1 },
  { name: "TypeORM", packageDeps: ["typeorm"], minScore: 1 },
  { name: "Drizzle", packageDeps: ["drizzle-orm"], minScore: 1 },
  { name: "Sequelize", packageDeps: ["sequelize"], minScore: 1 },
  { name: "SQLAlchemy", packageDeps: ["sqlalchemy"], minScore: 1 },
  { name: "ActiveRecord", files: ["Gemfile"], packageDeps: ["activerecord"], minScore: 1 },
  { name: "GORM", packageDeps: ["gorm.io/gorm"], minScore: 1 },
  { name: "Diesel", packageDeps: ["diesel"], minScore: 1 },
];

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".swift": "Swift",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".hs": "Haskell",
  ".lua": "Lua",
  ".r": "R",
  ".dart": "Dart",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const IGNORE_DIRS = new Set([
  "vendor",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
  "out",
]);

function shouldIgnore(path: string): boolean {
  const parts = path.split("/");
  return parts.some((p) => IGNORE_DIRS.has(p));
}

export class LanguageDetector {
  private readonly repoPath: string;
  private readonly allDeps = new Set<string>();
  private readonly allFiles: string[];

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    const git = new GitReader(repoPath);
    this.allFiles = git.isGitRepo() ? git.getTrackedFiles() : [];
    this.loadDependencies();
  }

  detect(): {
    languages: Array<{ name: string; files: number; percentage: number }>;
    frameworks: string[];
    testFrameworks: string[];
    buildTools: string[];
    packageManagers: string[];
    orms: string[];
    ciSystems: string[];
  } {
    const languages = this.detectLanguages();
    return {
      languages,
      frameworks: this.matchSignatures(FRAMEWORK_SIGNATURES),
      testFrameworks: this.matchSignatures(TEST_FRAMEWORK_SIGNATURES),
      buildTools: this.matchSignatures(BUILD_TOOL_SIGNATURES),
      packageManagers: this.detectPackageManagers(),
      orms: this.matchSignatures(ORM_SIGNATURES),
      ciSystems: this.detectCISystems(),
    };
  }

  private detectLanguages(): Array<{
    name: string;
    files: number;
    percentage: number;
  }> {
    const counts = new Map<string, number>();
    let total = 0;

    for (const file of this.allFiles) {
      if (shouldIgnore(file)) continue;
      const ext = extname(file).toLowerCase();
      const lang = EXTENSION_MAP[ext];
      if (lang) {
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
        total++;
      }
    }

    return [...counts.entries()]
      .map(([name, files]) => ({
        name,
        files,
        percentage: total > 0 ? Math.round((files / total) * 100) : 0,
      }))
      .sort((a, b) => b.files - a.files);
  }

  private loadDependencies(): void {
    // package.json
    this.loadJsonDeps(join(this.repoPath, "package.json"), (pkg) => [
      ...Object.keys((pkg as Record<string, Record<string, string>>).dependencies ?? {}),
      ...Object.keys((pkg as Record<string, Record<string, string>>).devDependencies ?? {}),
    ]);

    // pom.xml (Maven) — scan all pom.xml files for multi-module projects
    const pomFiles = this.allFiles.filter((f) => f.endsWith("/pom.xml") || f === "pom.xml");
    if (pomFiles.length === 0 && existsSync(join(this.repoPath, "pom.xml"))) {
      pomFiles.push("pom.xml");
    }
    for (const pomFile of pomFiles) {
      const pomPath = join(this.repoPath, pomFile);
      if (!existsSync(pomPath)) continue;
      try {
        const content = readFileSync(pomPath, "utf-8");
        for (const match of content.matchAll(/<artifactId>(.+?)<\/artifactId>/g)) {
          if (match[1]) this.allDeps.add(match[1]);
        }
      } catch {
        // ignore
      }
    }

    // go.mod
    const goMod = join(this.repoPath, "go.mod");
    if (existsSync(goMod)) {
      try {
        const content = readFileSync(goMod, "utf-8");
        for (const match of content.matchAll(/\t(.+?)\s/g)) {
          if (match[1]) this.allDeps.add(match[1]);
        }
      } catch {
        // ignore
      }
    }

    // Cargo.toml
    const cargo = join(this.repoPath, "Cargo.toml");
    if (existsSync(cargo)) {
      try {
        const content = readFileSync(cargo, "utf-8");
        for (const match of content.matchAll(/^(\w[\w-]*)\s*=/gm)) {
          if (match[1]) this.allDeps.add(match[1]);
        }
      } catch {
        // ignore
      }
    }

    // requirements.txt / Pipfile / pyproject.toml
    for (const pyFile of [
      "requirements.txt",
      "requirements-dev.txt",
      "Pipfile",
    ]) {
      const path = join(this.repoPath, pyFile);
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, "utf-8");
          for (const line of content.split("\n")) {
            const pkg = line.trim().split(/[=<>!~\s[]/)[0];
            if (pkg && !pkg.startsWith("#") && !pkg.startsWith("-")) {
              this.allDeps.add(pkg.toLowerCase());
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // Gemfile
    const gemfile = join(this.repoPath, "Gemfile");
    if (existsSync(gemfile)) {
      try {
        const content = readFileSync(gemfile, "utf-8");
        for (const match of content.matchAll(/gem\s+['"](.+?)['"]/g)) {
          if (match[1]) this.allDeps.add(match[1]);
        }
      } catch {
        // ignore
      }
    }
  }

  private loadJsonDeps(
    path: string,
    extract: (data: unknown) => string[],
  ): void {
    if (!existsSync(path)) return;
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
      for (const dep of extract(data)) {
        this.allDeps.add(dep);
      }
    } catch {
      // ignore
    }
  }

  private matchSignatures(signatures: FrameworkSignature[]): string[] {
    const matched: string[] = [];
    for (const sig of signatures) {
      let score = 0;

      if (sig.files) {
        for (const f of sig.files) {
          if (existsSync(join(this.repoPath, f))) score++;
        }
      }

      if (sig.packageDeps) {
        for (const dep of sig.packageDeps) {
          // Exact match or substring match (for Maven artifactIds like spring-boot-starter-web)
          if (this.allDeps.has(dep) || [...this.allDeps].some((d) => d.includes(dep))) score++;
        }
      }

      if (score >= sig.minScore) matched.push(sig.name);
    }
    return matched;
  }

  private detectPackageManagers(): string[] {
    const managers: string[] = [];
    const checks: [string, string][] = [
      ["package-lock.json", "npm"],
      ["yarn.lock", "Yarn"],
      ["pnpm-lock.yaml", "pnpm"],
      ["bun.lockb", "Bun"],
      ["Pipfile.lock", "Pipenv"],
      ["poetry.lock", "Poetry"],
      ["Gemfile.lock", "Bundler"],
      ["go.sum", "Go Modules"],
      ["Cargo.lock", "Cargo"],
      ["composer.lock", "Composer"],
    ];
    for (const [file, name] of checks) {
      if (existsSync(join(this.repoPath, file))) managers.push(name);
    }
    return managers;
  }

  private detectCISystems(): string[] {
    const systems: string[] = [];
    const checks: [string, string][] = [
      [".github/workflows", "GitHub Actions"],
      [".gitlab-ci.yml", "GitLab CI"],
      ["Jenkinsfile", "Jenkins"],
      [".circleci", "CircleCI"],
      [".travis.yml", "Travis CI"],
      ["azure-pipelines.yml", "Azure Pipelines"],
      ["bitbucket-pipelines.yml", "Bitbucket Pipelines"],
    ];
    for (const [path, name] of checks) {
      if (existsSync(join(this.repoPath, path))) systems.push(name);
    }
    return systems;
  }
}

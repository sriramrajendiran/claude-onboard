import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { GitReader } from "./git.js";

export interface FrameworkQuestion {
  question: string;
  context: string;
  /** Only ask if this condition returns true given the project's dependency list */
  condition?: (deps: Set<string>) => boolean;
}

interface FrameworkSignature {
  name: string;
  files?: string[];
  packageDeps?: string[];
  minScore: number;
  questions?: FrameworkQuestion[];
}

const FRAMEWORK_SIGNATURES: FrameworkSignature[] = [
  {
    name: "Next.js", packageDeps: ["next"], minScore: 1,
    questions: [
      { question: "Do you use App Router or Pages Router (or both)?", context: "Next.js routing strategy affects component patterns, data fetching, and file structure" },
      { question: "Are components Server Components by default, or mostly client-side?", context: "Determines whether to add 'use client' directives and how to handle state" },
      { question: "What data fetching pattern do you use? (RSC async, React Query, SWR, tRPC, fetch in Server Actions)", context: "Affects how new features should load and cache data" },
      { question: "Do you use Server Actions, API routes, or an external API for mutations?", context: "Determines where to put write operations and form handling" },
    ],
  },
  {
    name: "React", packageDeps: ["react", "react-dom"], minScore: 2,
    questions: [
      { question: "What state management do you use? (Redux, Zustand, Jotai, MobX, Context, or none)", context: "Determines how new components should read/write shared state" },
      { question: "What styling approach? (Tailwind, CSS Modules, styled-components, Emotion, plain CSS)", context: "New components should follow the established styling pattern" },
      { question: "What routing library? (React Router, TanStack Router, or framework-provided)", context: "Affects how to add new pages and navigation", condition: (deps) => !deps.has("next") },
    ],
  },
  {
    name: "Vue", packageDeps: ["vue"], minScore: 1,
    questions: [
      { question: "Options API or Composition API?", context: "Vue 3 supports both — new components should match the project convention" },
      { question: "What state management? (Pinia, Vuex, or composables)", context: "Determines where shared state lives" },
    ],
  },
  { name: "Angular", packageDeps: ["@angular/core"], minScore: 1 },
  { name: "Svelte", packageDeps: ["svelte"], minScore: 1 },
  {
    name: "Express", packageDeps: ["express"], minScore: 1,
    questions: [
      { question: "What auth strategy? (JWT, sessions, OAuth, API keys)", context: "Auth approach affects middleware, route guards, and how to protect new endpoints" },
      { question: "How are routes organized? (single file, feature folders, controller classes)", context: "Determines where to add new endpoints" },
      { question: "Do you use raw SQL, a query builder, or an ORM for database access?", context: "Affects how to write data access code in new features" },
    ],
  },
  {
    name: "Fastify", packageDeps: ["fastify"], minScore: 1,
    questions: [
      { question: "What auth strategy? (JWT, sessions, OAuth, API keys)", context: "Auth approach affects hooks, decorators, and how to protect new routes" },
      { question: "Do you use the Fastify plugin system for feature organization?", context: "Determines how to structure new functionality" },
    ],
  },
  {
    name: "NestJS", packageDeps: ["@nestjs/core"], minScore: 1,
    questions: [
      { question: "Do you use the default Express adapter or Fastify?", context: "Affects middleware compatibility and performance patterns" },
      { question: "How do you handle auth? (@nestjs/passport, custom guards, external service)", context: "Determines guard and decorator patterns for new modules" },
    ],
  },
  {
    name: "Django", files: ["manage.py"], packageDeps: ["django"], minScore: 1,
    questions: [
      { question: "Django REST Framework or plain Django views?", context: "DRF has serializers, viewsets, and routers — plain Django uses templates/forms" },
      { question: "Class-based views or function-based views?", context: "New views should match the existing pattern" },
      { question: "Do you use Celery or another task queue for background jobs?", context: "Affects how to handle long-running operations" },
    ],
  },
  {
    name: "FastAPI", packageDeps: ["fastapi"], minScore: 1,
    questions: [
      { question: "How do you organize routers? (single file, feature folders, APIRouter per domain)", context: "Determines where to add new endpoints" },
      { question: "What database pattern? (SQLAlchemy with sessions, Tortoise ORM, raw asyncpg)", context: "Affects how to write data access in new features" },
      { question: "Do you use Pydantic v1 or v2 model patterns?", context: "v1 and v2 have different syntax for validators and model config" },
    ],
  },
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
  {
    name: "Prisma", packageDeps: ["prisma", "@prisma/client"], minScore: 1,
    questions: [
      { question: "Do you use raw SQL ($queryRaw) for complex queries, or strictly Prisma Client?", context: "Determines whether new features can use raw SQL or must use the Prisma query API" },
    ],
  },
  {
    name: "TypeORM", packageDeps: ["typeorm"], minScore: 1,
    questions: [
      { question: "Do you use Active Record or Data Mapper pattern with TypeORM?", context: "Active Record puts queries on entities; Data Mapper uses repositories" },
    ],
  },
  {
    name: "Drizzle", packageDeps: ["drizzle-orm"], minScore: 1,
    questions: [
      { question: "Do you use Drizzle's relational queries or raw SQL builder for complex joins?", context: "Affects how to write data access for new features" },
    ],
  },
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
  readonly deps = new Set<string>();
  private readonly allDeps = this.deps;
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

/** Get framework-specific HITL questions for detected frameworks and ORMs. */
export function getFrameworkQuestions(
  detectedFrameworks: string[],
  detectedOrms: string[],
  deps: Set<string>,
): Array<{ framework: string; question: string; context: string }> {
  const results: Array<{ framework: string; question: string; context: string }> = [];
  const allSigs = [...FRAMEWORK_SIGNATURES, ...ORM_SIGNATURES];

  const detected = new Set([...detectedFrameworks, ...detectedOrms]);
  for (const sig of allSigs) {
    if (!detected.has(sig.name) || !sig.questions) continue;
    for (const q of sig.questions) {
      if (q.condition && !q.condition(deps)) continue;
      results.push({ framework: sig.name, question: q.question, context: q.context });
    }
  }
  return results;
}

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { GitReader } from "./git.js";

/**
 * Represents a directory "module" in the codebase with its purpose and key files.
 */
export interface ModuleInfo {
  path: string;
  fileCount: number;
  changeCount: number;
  keyFiles: string[];        // most-changed files in this dir
  classNames: string[];      // detected class/interface names
  description: string;       // inferred purpose
  children: ModuleInfo[];
}

/**
 * A key class/interface/type discovered by reading source headers.
 */
export interface KeyType {
  name: string;
  file: string;
  kind: "class" | "interface" | "enum" | "trait" | "struct" | "type" | "function";
  superTypes: string[];      // extends/implements
  annotations: string[];     // @Entity, @Controller, etc.
  linesOfCode: number;
  description: string;       // first doc comment or inferred
}

/**
 * A detected dependency (from pom.xml, package.json, go.mod, etc.) with grouping.
 */
export interface DependencyInfo {
  name: string;
  version: string;
  group: string;  // "database", "web", "cache", "messaging", "testing", "utility", etc.
}

export interface SourceAnalysis {
  modules: ModuleInfo[];
  keyTypes: KeyType[];
  dependencies: DependencyInfo[];
  packageStructure: string;        // inferred root package (e.g. "net.loadshare.genesis")
  configFiles: ConfigFile[];
  hotpathDirs: string[];           // directories that should get their own CLAUDE.md
  buildCommands: BuildCommand[];   // actual commands to build/test/run
  codePatterns: CodePatternInsight[];  // detected code-level patterns and idioms
  todoComments: TodoComment[];     // TODO/FIXME/HACK comments found in source
  commitPatterns: CommitPatternInsight; // deeper commit message analysis
  projectDescription: string;     // from README or pom.xml description
  teamRules: string[];            // content from code-review.rules, .cursor/rules, etc.
  serviceMap: ServiceInfo[];      // microservices from docker-compose
}

export interface BuildCommand {
  name: string;       // "build", "test", "run", "lint", "deploy"
  command: string;    // the actual command
  source: string;     // where we found it (pom.xml, package.json, Makefile, etc.)
}

export interface CodePatternInsight {
  name: string;       // e.g. "Lombok Builder pattern", "Vavr Either for errors"
  description: string;
  examples: string[]; // file paths showing this pattern
}

export interface TodoComment {
  file: string;
  line: number;
  type: "TODO" | "FIXME" | "HACK" | "XXX";
  text: string;
}

export interface CommitPatternInsight {
  style: string;          // "free-form", "conventional", "jira-prefixed"
  branchPattern: string;  // e.g. "feature/<name>", "feature/dev_<author>/<name>"
  exampleMessages: string[];
  mergeStrategy: string;  // "squash", "merge-commit", "rebase"
  avgCommitsPerPR: number;
}

export interface ServiceInfo {
  name: string;
  port?: string;
  dependsOn: string[];
}

export interface ConfigFile {
  path: string;
  type: "spring" | "env" | "docker" | "ci" | "build" | "lint" | "other";
  summary: string;
}

// Patterns to classify Java/Spring annotations
const ANNOTATION_CATEGORIES: Record<string, string> = {
  "@RestController": "REST controller",
  "@Controller": "MVC controller",
  "@Service": "service",
  "@Repository": "repository",
  "@Entity": "JPA entity",
  "@Component": "Spring component",
  "@Configuration": "Spring configuration",
  "@SpringBootApplication": "application entry point",
  "@Scheduled": "scheduled task",
  "@EventListener": "event handler",
};

// Dependency categorization for Maven
const MAVEN_DEP_GROUPS: [RegExp, string][] = [
  [/spring-boot-starter-web|spring-web|jakarta\.servlet/i, "web"],
  [/spring-boot-starter-data-jpa|hibernate|jpa|liquibase|flyway/i, "database"],
  [/spring-boot-starter-security|spring-security|oauth2|jwt/i, "security"],
  [/redis|redisson|lettuce|caffeine|ehcache/i, "cache"],
  [/sqs|kafka|rabbitmq|activemq|spring-cloud-stream/i, "messaging"],
  [/prometheus|micrometer|actuator|metrics/i, "monitoring"],
  [/junit|mockito|testcontainers|assertj|truth/i, "testing"],
  [/swagger|openapi|springdoc/i, "api-docs"],
  [/lombok/i, "code-gen"],
  [/jackson|gson/i, "serialization"],
  [/slf4j|logback|log4j/i, "logging"],
  [/postgis|h3|jts|spatial/i, "geospatial"],
  [/antlr/i, "parsing"],
  [/guava|vavr|commons/i, "utility"],
  [/okhttp|httpclient|feign|retrofit/i, "http-client"],
  [/aws|amazon/i, "aws"],
  [/slack/i, "slack"],
];

export class SourceAnalyzer {
  private readonly repoPath: string;
  private readonly files: string[];
  private readonly changeFreq: Map<string, number>;

  constructor(repoPath: string, changeFreq: Map<string, number>) {
    this.repoPath = repoPath;
    const git = new GitReader(repoPath);
    this.files = git.isGitRepo() ? git.getTrackedFiles() : [];
    this.changeFreq = changeFreq;
  }

  analyze(): SourceAnalysis {
    const modules = this.buildModuleTree();
    const keyTypes = this.discoverKeyTypes();
    const dependencies = this.parseDependencies();
    const packageStructure = this.inferPackageStructure();
    const configFiles = this.discoverConfigFiles();
    const hotpathDirs = this.identifyHotpathDirs(modules);
    const buildCommands = this.detectBuildCommands();
    const codePatterns = this.detectCodePatterns(keyTypes);
    const todoComments = this.scanTodoComments();
    const commitPatterns = this.analyzeCommitPatterns();
    const projectDescription = this.extractProjectDescription();
    const teamRules = this.detectTeamRules();
    const serviceMap = this.parseDockerCompose();

    return {
      modules, keyTypes, dependencies, packageStructure, configFiles, hotpathDirs,
      buildCommands, codePatterns, todoComments, commitPatterns, projectDescription,
      teamRules, serviceMap,
    };
  }

  private buildModuleTree(): ModuleInfo[] {
    // Build a map of directory → files
    const dirFiles = new Map<string, string[]>();
    for (const file of this.files) {
      const dir = dirname(file);
      if (dir === ".") continue;
      const existing = dirFiles.get(dir);
      if (existing) {
        existing.push(file);
      } else {
        dirFiles.set(dir, [file]);
      }
    }

    // Find "significant" directories (those with enough files to be modules)
    // We want 2-3 levels deep from src/
    // Detect source prefixes — handle nested structures like DeliveryExecutiveWebApp/*/src/main/java/
    const srcPrefixes = this.detectSourcePrefixes(dirFiles);
    const moduleRoots: string[] = [];

    for (const prefix of srcPrefixes) {
      const matchingDirs = [...dirFiles.keys()].filter((d) => d.startsWith(prefix + "/"));
      if (matchingDirs.length === 0) continue;

      // Find directories that are 2-4 levels deep from the prefix
      const depth = prefix.split("/").length;
      const candidates = new Set<string>();
      for (const dir of matchingDirs) {
        const parts = dir.split("/");
        // Get directory at depth+1, depth+2, depth+3
        for (let i = depth + 1; i <= Math.min(depth + 4, parts.length); i++) {
          candidates.add(parts.slice(0, i).join("/"));
        }
      }

      for (const candidate of candidates) {
        const filesInDir = [...dirFiles.entries()]
          .filter(([d]) => d === candidate || d.startsWith(candidate + "/"))
          .reduce((sum, [, files]) => sum + files.length, 0);

        if (filesInDir >= 3) {
          moduleRoots.push(candidate);
        }
      }
    }

    // Also add top-level service modules for multi-module projects (e.g. DeliveryExecutiveWebApp/user-service/)
    const serviceModules = this.detectServiceModules(dirFiles);
    moduleRoots.push(...serviceModules);

    // Deduplicate: if a parent has a child, keep both but structure as tree
    const topModules: ModuleInfo[] = [];
    const sorted = [...new Set(moduleRoots)].sort();

    for (const dir of sorted) {
      // Skip if ANY parent is already in the list (we'll add as child)
      const isChild = sorted.some(
        (other) => other !== dir && dir.startsWith(other + "/"),
      );
      if (isChild) continue;

      topModules.push(this.buildModule(dir, dirFiles, sorted));
    }

    return topModules
      .filter((m) => m.fileCount > 0)
      .sort((a, b) => b.changeCount - a.changeCount);
  }

  private buildModule(
    dir: string,
    dirFiles: Map<string, string[]>,
    allModulePaths: string[],
  ): ModuleInfo {
    const filesInDir = [...dirFiles.entries()]
      .filter(([d]) => d === dir || d.startsWith(dir + "/"))
      .flatMap(([, files]) => files);

    const changeCount = filesInDir.reduce(
      (sum, f) => sum + (this.changeFreq.get(f) ?? 0),
      0,
    );

    const keyFiles = filesInDir
      .map((f) => ({ path: f, changes: this.changeFreq.get(f) ?? 0 }))
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 5)
      .map((f) => f.path);

    const classNames = this.extractClassNames(filesInDir.slice(0, 20));

    // Find direct children that are also modules
    const children = allModulePaths
      .filter((p) => {
        if (p === dir) return false;
        if (!p.startsWith(dir + "/")) return false;
        const remaining = p.slice(dir.length + 1);
        return !remaining.includes("/"); // direct child only
      })
      .map((childDir) => this.buildModule(childDir, dirFiles, allModulePaths));

    const dirName = basename(dir);
    const description = this.inferModulePurpose(dirName, classNames, filesInDir);

    return {
      path: dir,
      fileCount: filesInDir.length,
      changeCount,
      keyFiles,
      classNames: classNames.slice(0, 10),
      description,
      children: children.sort((a, b) => b.changeCount - a.changeCount),
    };
  }

  private extractClassNames(files: string[]): string[] {
    const names: string[] = [];
    for (const file of files) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;

      const ext = extname(file);
      try {
        // Only read first 50 lines to find class/interface declarations
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n").slice(0, 80);

        for (const line of lines) {
          let match: RegExpMatchArray | null;
          if (ext === ".java") {
            match = line.match(
              /(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/,
            );
          } else if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
            match = line.match(
              /(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum)\s+(\w+)/,
            );
          } else if (ext === ".py") {
            match = line.match(/^class\s+(\w+)/);
          } else if (ext === ".go") {
            match = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);
          } else if (ext === ".rs") {
            match = line.match(/^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/);
          } else {
            match = null;
          }
          if (match?.[1]) names.push(match[1]);
        }
      } catch {
        // skip unreadable files
      }
    }
    return names;
  }

  private inferModulePurpose(
    dirName: string,
    classNames: string[],
    files: string[],
  ): string {
    // Common directory name patterns
    const purposeMap: Record<string, string> = {
      controller: "REST API controllers",
      controllers: "REST API controllers",
      service: "Business logic services",
      services: "Business logic services",
      repository: "Data access repositories",
      repositories: "Data access repositories",
      entity: "JPA/database entities",
      entities: "JPA/database entities",
      model: "Domain models",
      models: "Domain models",
      domain: "Core domain logic",
      adapter: "Port adapters (hexagonal architecture)",
      adapters: "Port adapters (hexagonal architecture)",
      port: "Interface ports (hexagonal architecture)",
      ports: "Interface ports (hexagonal architecture)",
      mapper: "Data mapping/transformation",
      mappers: "Data mapping/transformation",
      config: "Configuration",
      configuration: "Configuration",
      infrastructure: "Infrastructure and cross-cutting concerns",
      middleware: "Request/response middleware",
      handler: "Event/request handlers",
      handlers: "Event/request handlers",
      util: "Utility functions",
      utils: "Utility functions",
      helpers: "Helper functions",
      integration: "External service integrations",
      web: "Web/HTTP layer",
      api: "API layer",
      persistence: "Data persistence layer",
      core: "Core business domain",
      rules: "Business rules engine",
      cache: "Caching layer",
      engine: "Processing engines",
      strategy: "Strategy pattern implementations",
      allocation: "Allocation logic",
      simulation: "Simulation/what-if analysis",
      sqs: "AWS SQS message processing",
      jdbc: "Raw JDBC data access",
      bo: "Business objects (transient models)",
      constants: "System constants and configuration values",
      test: "Tests",
      tests: "Tests",
      spec: "Test specifications",
      migration: "Database migrations",
      migrations: "Database migrations",
    };

    const lower = dirName.toLowerCase();
    if (purposeMap[lower]) return purposeMap[lower]!;

    // Try matching partial names
    for (const [key, purpose] of Object.entries(purposeMap)) {
      if (lower.includes(key)) return purpose;
    }

    // Infer from class names and annotations
    if (classNames.some((c) => /Controller$/.test(c))) return "REST controllers";
    if (classNames.some((c) => /Service$/.test(c))) return "Service layer";
    if (classNames.some((c) => /Repository$/.test(c))) return "Data access";
    if (classNames.some((c) => /Entity$/.test(c))) return "Database entities";
    if (classNames.some((c) => /Adapter$/.test(c))) return "Adapters";
    if (classNames.some((c) => /Engine$/.test(c))) return "Processing engines";

    return `${files.length} files`;
  }

  discoverKeyTypes(): KeyType[] {
    const types: KeyType[] = [];
    // Focus on most-changed files
    const topFiles = [...this.changeFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([path]) => path)
      .filter((f) => !f.includes("test") && !f.includes("Test"));

    for (const file of topFiles) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;

      const ext = extname(file);
      if (![".java", ".ts", ".tsx", ".py", ".go", ".rs", ".kt"].includes(ext)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        const loc = lines.length;

        // Parse based on language
        if (ext === ".java") {
          types.push(...this.parseJavaTypes(file, lines, loc));
        } else if (ext === ".ts" || ext === ".tsx") {
          types.push(...this.parseTsTypes(file, lines, loc));
        }
      } catch {
        // skip
      }

      if (types.length >= 60) break;
    }

    return types.sort((a, b) => b.linesOfCode - a.linesOfCode);
  }

  private parseJavaTypes(file: string, lines: string[], loc: number): KeyType[] {
    const types: KeyType[] = [];
    const annotations: string[] = [];
    let docComment = "";

    for (let i = 0; i < Math.min(lines.length, 100); i++) {
      const line = lines[i]!.trim();

      // Collect annotations
      if (line.startsWith("@")) {
        const ann = line.match(/@(\w+)/)?.[0];
        if (ann) annotations.push(ann);
      }

      // Collect javadoc
      if (line.startsWith("/**")) {
        docComment = "";
        for (let j = i; j < Math.min(i + 10, lines.length); j++) {
          const docLine = lines[j]!.trim();
          if (docLine.includes("*/")) break;
          const cleaned = docLine.replace(/^[\s/*]+/, "").trim();
          if (cleaned && !cleaned.startsWith("@")) {
            docComment += (docComment ? " " : "") + cleaned;
          }
        }
      }

      // Match class/interface/enum declaration
      const match = line.match(
        /(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(class|interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?(?:\s*\{|$)/,
      );
      if (match) {
        const kind = match[1] as "class" | "interface" | "enum";
        const name = match[2]!;
        const superTypes: string[] = [];
        if (match[3]) superTypes.push(match[3]);
        if (match[4]) {
          superTypes.push(
            ...match[4].split(",").map((s) => s.trim().split("<")[0]!.trim()),
          );
        }

        // Infer description from annotations, name, or doc comment
        let description = docComment;
        if (!description) {
          for (const ann of annotations) {
            if (ANNOTATION_CATEGORIES[ann]) {
              description = ANNOTATION_CATEGORIES[ann]!;
              break;
            }
          }
        }
        if (!description) {
          description = this.inferTypeDescription(name);
        }

        types.push({
          name,
          file,
          kind,
          superTypes,
          annotations: [...annotations],
          linesOfCode: loc,
          description,
        });
        break; // One type per file for Java
      }
    }

    return types;
  }

  private parseTsTypes(file: string, lines: string[], loc: number): KeyType[] {
    const types: KeyType[] = [];

    for (let i = 0; i < Math.min(lines.length, 60); i++) {
      const line = lines[i]!.trim();
      const match = line.match(
        /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|type|enum)\s+(\w+)/,
      );
      if (match) {
        types.push({
          name: match[2]!,
          file,
          kind: match[1] as "class" | "interface" | "type" | "enum",
          superTypes: [],
          annotations: [],
          linesOfCode: loc,
          description: this.inferTypeDescription(match[2]!),
        });
      }
    }

    return types;
  }

  private inferTypeDescription(name: string): string {
    if (/Engine$/.test(name)) return "Processing engine";
    if (/Service$/.test(name)) return "Business service";
    if (/Controller$/.test(name)) return "REST controller";
    if (/Repository$/.test(name)) return "Data repository";
    if (/Adapter$/.test(name)) return "Adapter";
    if (/Mapper$/.test(name)) return "Data mapper";
    if (/Entity$/.test(name)) return "Database entity";
    if (/Config/.test(name)) return "Configuration";
    if (/Helper$/.test(name)) return "Helper utility";
    if (/Handler$/.test(name)) return "Handler";
    if (/Factory$/.test(name)) return "Factory";
    if (/Strategy$/.test(name)) return "Strategy";
    if (/Builder$/.test(name)) return "Builder";
    if (/Validator$/.test(name)) return "Validator";
    if (/Filter$/.test(name)) return "Filter";
    if (/Interceptor$/.test(name)) return "Interceptor";
    if (/Listener$/.test(name)) return "Event listener";
    return "";
  }

  private parseDependencies(): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const seen = new Set<string>();

    // Maven pom.xml — scan ALL pom.xml files in multi-module projects
    const pomFiles = this.files.filter((f) => f.endsWith("/pom.xml") || f === "pom.xml");
    if (pomFiles.length === 0 && existsSync(join(this.repoPath, "pom.xml"))) {
      pomFiles.push("pom.xml");
    }
    for (const pomFile of pomFiles) {
      const pomPath = join(this.repoPath, pomFile);
      if (!existsSync(pomPath)) continue;
      try {
        const content = readFileSync(pomPath, "utf-8");
        const depRegex =
          /<dependency>\s*<groupId>(.+?)<\/groupId>\s*<artifactId>(.+?)<\/artifactId>(?:\s*<version>(.+?)<\/version>)?/gs;
        let match;
        while ((match = depRegex.exec(content)) !== null) {
          const groupId = match[1] ?? "";
          const artifactId = match[2] ?? "";
          const version = match[3] ?? "";
          const fullName = `${groupId}:${artifactId}`;
          if (seen.has(fullName)) continue;
          seen.add(fullName);
          deps.push({
            name: fullName,
            version,
            group: this.categorizeDep(fullName),
          });
        }
      } catch {
        // skip
      }
    }

    // package.json (already handled by LanguageDetector but we want categorization)
    const pkgPath = join(this.repoPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, Record<string, string>>;
        for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
          deps.push({ name, version, group: this.categorizeDep(name) });
        }
        for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
          deps.push({ name, version, group: this.categorizeDep(name) });
        }
      } catch {
        // skip
      }
    }

    return deps;
  }

  private categorizeDep(name: string): string {
    for (const [pattern, group] of MAVEN_DEP_GROUPS) {
      if (pattern.test(name)) return group;
    }
    return "other";
  }

  private inferPackageStructure(): string {
    // Look for the common Java package prefix (handles nested like DeliveryExecutiveWebApp/*/src/main/java/)
    const javaFiles = this.files.filter(
      (f) => f.endsWith(".java") && f.includes("src/main/java/"),
    );
    if (javaFiles.length > 0) {
      const first = javaFiles[0]!;
      const javaIdx = first.indexOf("src/main/java/");
      const afterJava = first.slice(javaIdx + "src/main/java/".length);
      const parts = afterJava.split("/");
      // Take first 3-4 parts as package
      const pkgParts = parts.slice(0, Math.min(4, parts.length - 1));
      return pkgParts.join(".");
    }

    // For TS/JS projects, look for src/ structure
    const srcFiles = this.files.filter((f) => f.startsWith("src/"));
    if (srcFiles.length > 0) return "src/";

    return "";
  }

  private discoverConfigFiles(): ConfigFile[] {
    const configs: ConfigFile[] = [];

    const checks: [string | RegExp, ConfigFile["type"], string][] = [
      ["application.yml", "spring", "Spring Boot configuration"],
      ["application.yaml", "spring", "Spring Boot configuration"],
      ["application.properties", "spring", "Spring Boot configuration"],
      ["bootstrap.yml", "spring", "Spring Cloud bootstrap config"],
      [/application-\w+\.yml$/, "spring", "Environment-specific Spring config"],
      ["Dockerfile", "docker", "Docker container definition"],
      ["docker-compose.yml", "docker", "Docker Compose services"],
      ["docker-compose.yaml", "docker", "Docker Compose services"],
      [".env", "env", "Environment variables"],
      [".env.example", "env", "Environment variables template"],
      ["pom.xml", "build", "Maven build configuration"],
      ["build.gradle", "build", "Gradle build configuration"],
      ["tsconfig.json", "build", "TypeScript configuration"],
      ["webpack.config.js", "build", "Webpack bundler configuration"],
      [".eslintrc.json", "lint", "ESLint configuration"],
      ["prettier.config.js", "lint", "Prettier configuration"],
    ];

    for (const [pattern, type, summary] of checks) {
      if (typeof pattern === "string") {
        if (this.files.includes(pattern) || existsSync(join(this.repoPath, pattern))) {
          configs.push({ path: pattern, type, summary });
        }
      } else {
        for (const file of this.files) {
          if (pattern.test(file)) {
            configs.push({ path: file, type, summary: `${summary} (${basename(file)})` });
          }
        }
      }
    }

    return configs;
  }

  /**
   * Identify directories that are "hot enough" to deserve their own CLAUDE.md.
   * Criteria: high change frequency, sufficient files, meaningful depth.
   */
  private identifyHotpathDirs(modules: ModuleInfo[]): string[] {
    // Flatten all modules
    const flatModules: ModuleInfo[] = [];
    const flatten = (ms: ModuleInfo[]) => {
      for (const m of ms) {
        flatModules.push(m);
        flatten(m.children);
      }
    };
    flatten(modules);

    // Prefer leaf-ish directories with actual domain meaning.
    // Skip intermediate package paths (e.g. src/main/java/net/) that just contain other packages.
    const sorted = flatModules
      .filter((m) => m.fileCount >= 3 && m.changeCount >= 5)
      .filter((m) => {
        // Skip intermediate dirs: they have children but no direct source files
        if (m.classNames.length === 0 && m.children.length > 0) return false;
        // Skip shallow Java package paths (net/, loadshare/, etc.)
        const parts = m.path.split("/");
        const javaIdx = parts.indexOf("java");
        if (javaIdx >= 0 && parts.length - javaIdx <= 3) return false;
        // Skip generic paths like "src/main", "src/main/resources"
        if (/^src\/(main|test)(\/resources)?$/.test(m.path)) return false;
        return true;
      })
      .sort((a, b) => b.changeCount - a.changeCount);

    // Take top 10 most active directories, allowing siblings
    const dirs: string[] = [];
    for (const m of sorted) {
      if (dirs.length >= 10) break;
      // Skip exact duplicates
      if (dirs.includes(m.path)) continue;
      dirs.push(m.path);
    }

    return dirs;
  }

  /**
   * Detect all source prefixes in the repo, handling multi-module projects.
   * E.g. DeliveryExecutiveWebApp/user-service/src/main/java, authentication/src/main/java, src/main/java
   */
  private detectSourcePrefixes(dirFiles: Map<string, string[]>): string[] {
    const allDirs = [...dirFiles.keys()];
    const prefixes: string[] = [];
    const seen = new Set<string>();

    // Find all src/main/java (or src/main, src, app, lib, pkg, internal) paths
    const srcPatterns = ["src/main/java", "src/main", "src", "app", "lib", "pkg", "internal"];
    for (const pattern of srcPatterns) {
      for (const dir of allDirs) {
        const idx = dir.indexOf(pattern + "/");
        if (idx < 0) continue;
        const prefix = dir.slice(0, idx + pattern.length);
        if (!seen.has(prefix)) {
          seen.add(prefix);
          prefixes.push(prefix);
        }
      }
    }

    // If no specific prefixes found, fall back to simple ones
    if (prefixes.length === 0) {
      for (const p of srcPatterns) {
        if (allDirs.some((d) => d.startsWith(p + "/"))) {
          prefixes.push(p);
          break;
        }
      }
    }

    return prefixes;
  }

  /**
   * Detect top-level service modules in multi-module projects.
   * E.g. for DeliveryExecutiveWebApp/{user-service,authentication,...} with their own pom.xml
   */
  private detectServiceModules(dirFiles: Map<string, string[]>): string[] {
    const modules: string[] = [];
    // Find directories that have pom.xml, build.gradle, or are clearly service modules
    const pomFiles = this.files.filter((f) => f.endsWith("/pom.xml") || f === "pom.xml");
    for (const pom of pomFiles) {
      if (pom === "pom.xml") continue;
      const dir = dirname(pom);
      // Only add if this directory has source files
      const hasSource = [...dirFiles.keys()].some((d) => d.startsWith(dir + "/") && d.includes("/src/"));
      if (hasSource) modules.push(dir);
    }
    return modules;
  }

  /**
   * Find the parent/root pom.xml in a multi-module Maven project.
   * The parent pom has <modules> and is the shallowest pom.xml.
   */
  private findParentPom(pomFiles: string[]): string | undefined {
    if (pomFiles.length === 0) return undefined;
    if (pomFiles.includes("pom.xml")) return "pom.xml";
    // Sort by depth, shallowest first
    const sorted = [...pomFiles].sort((a, b) => a.split("/").length - b.split("/").length);
    // The shallowest pom.xml with <modules> is the parent
    for (const pom of sorted) {
      const fullPath = join(this.repoPath, pom);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes("<modules>")) return pom;
      } catch { /* skip */ }
    }
    return sorted[0];
  }

  private detectBuildCommands(): BuildCommand[] {
    const cmds: BuildCommand[] = [];

    // Maven — find the actual build root (may be nested like DeliveryExecutiveWebApp/)
    const pomFiles = this.files.filter((f) => f.endsWith("/pom.xml") || f === "pom.xml");
    const parentPom = this.findParentPom(pomFiles);
    const pomDir = parentPom ? dirname(parentPom) : ".";
    const pomPath = join(this.repoPath, parentPom ?? "pom.xml");
    const hasMvnw = existsSync(join(this.repoPath, "mvnw")) || existsSync(join(this.repoPath, pomDir, "mvnw"));
    const mvn = hasMvnw ? "./mvnw" : "mvn";
    const cdPrefix = pomDir !== "." ? `cd ${pomDir} && ` : "";
    if (existsSync(pomPath)) {
      cmds.push({ name: "build", command: `${cdPrefix}${mvn} clean package -DskipTests`, source: parentPom ?? "pom.xml" });
      cmds.push({ name: "test", command: `${cdPrefix}${mvn} test`, source: parentPom ?? "pom.xml" });
      // Check for spring-boot plugin in any pom
      try {
        let hasSpringBoot = false;
        let hasAntlr = false;
        for (const pf of pomFiles.slice(0, 15)) {
          const pfPath = join(this.repoPath, pf);
          if (!existsSync(pfPath)) continue;
          const content = readFileSync(pfPath, "utf-8");
          if (content.includes("spring-boot-maven-plugin")) hasSpringBoot = true;
          if (content.includes("antlr4-maven-plugin")) hasAntlr = true;
        }
        if (hasSpringBoot) {
          cmds.push({ name: "run", command: `${cdPrefix}${mvn} spring-boot:run`, source: parentPom ?? "pom.xml" });
        }
        if (hasAntlr) {
          cmds.push({ name: "generate-sources", command: `${cdPrefix}${mvn} generate-sources`, source: "pom.xml (ANTLR4)" });
        }
      } catch { /* skip */ }

      // For multi-module: list the modules
      if (pomFiles.length >= 3) {
        try {
          const content = readFileSync(pomPath, "utf-8");
          const moduleMatches = content.matchAll(/<module>(.+?)<\/module>/g);
          const modules = [...moduleMatches].map((m) => m[1]).filter(Boolean);
          if (modules.length > 0) {
            const moduleStr = modules.join(", ");
            cmds.push({ name: "build-module", command: `${cdPrefix}${mvn} clean package -pl <module-name> -am`, source: `Modules: ${moduleStr}` });
          }
        } catch { /* skip */ }
      }
    }

    // Gradle
    const gradlew = existsSync(join(this.repoPath, "gradlew"));
    const gradle = gradlew ? "./gradlew" : "gradle";
    if (existsSync(join(this.repoPath, "build.gradle")) || existsSync(join(this.repoPath, "build.gradle.kts"))) {
      cmds.push({ name: "build", command: `${gradle} build`, source: "build.gradle" });
      cmds.push({ name: "test", command: `${gradle} test`, source: "build.gradle" });
    }

    // package.json scripts
    const pkgPath = join(this.repoPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, Record<string, string>>;
        const scripts = pkg.scripts ?? {};
        const npmCmd = existsSync(join(this.repoPath, "bun.lockb")) ? "bun" :
                       existsSync(join(this.repoPath, "pnpm-lock.yaml")) ? "pnpm" :
                       existsSync(join(this.repoPath, "yarn.lock")) ? "yarn" : "npm";
        const run = npmCmd === "npm" ? "npm run" : npmCmd;
        for (const [name, script] of Object.entries(scripts)) {
          if (["build", "test", "dev", "start", "lint", "typecheck", "format"].includes(name)) {
            cmds.push({ name, command: `${run} ${name}`, source: `package.json (${script})` });
          }
        }
      } catch { /* skip */ }
    }

    // Makefile
    if (existsSync(join(this.repoPath, "Makefile"))) {
      try {
        const makefile = readFileSync(join(this.repoPath, "Makefile"), "utf-8");
        const targets = makefile.match(/^([a-zA-Z_-]+):/gm);
        if (targets) {
          for (const t of targets.slice(0, 10)) {
            const name = t.replace(":", "");
            cmds.push({ name, command: `make ${name}`, source: "Makefile" });
          }
        }
      } catch { /* skip */ }
    }

    // Dockerfile
    const dockerfiles = this.files.filter((f) => /Dockerfile/.test(f));
    for (const df of dockerfiles.slice(0, 3)) {
      cmds.push({ name: "docker-build", command: `docker build -f ${df} -t app .`, source: df });
    }

    // Spring profiles (detect from application-*.yml, handles nested paths)
    const profiles = this.files
      .filter((f) => /application-(\w+)\.ya?ml$/.test(f) && f.includes("resources/"))
      .map((f) => f.match(/application-(\w+)/)?.[1])
      .filter(Boolean) as string[];
    // Deduplicate profiles
    const uniqueProfiles = [...new Set(profiles)];
    if (uniqueProfiles.length > 0 && cmds.some((c) => c.name === "run")) {
      cmds.push({
        name: "run-local",
        command: `${cdPrefix}${mvn} spring-boot:run -Dspring-boot.run.profiles=${uniqueProfiles.includes("local") ? "local" : uniqueProfiles[0]!}`,
        source: `Spring profiles: ${uniqueProfiles.join(", ")}`,
      });
    }

    return cmds;
  }

  private detectCodePatterns(keyTypes: KeyType[]): CodePatternInsight[] {
    const patterns: CodePatternInsight[] = [];
    const annotationCounts = new Map<string, string[]>();

    for (const t of keyTypes) {
      for (const ann of t.annotations) {
        const files = annotationCounts.get(ann);
        if (files) files.push(t.file);
        else annotationCounts.set(ann, [t.file]);
      }
    }

    // Detect Lombok patterns
    const lombokAnns = ["@Builder", "@Getter", "@Setter", "@Data", "@Value", "@AllArgsConstructor", "@NoArgsConstructor", "@Slf4j"];
    const usedLombok = lombokAnns.filter((a) => annotationCounts.has(a));
    if (usedLombok.length > 0) {
      patterns.push({
        name: "Lombok annotations",
        description: `Uses ${usedLombok.join(", ")} — generated boilerplate. Do not write manual getters/setters/constructors for classes using these.`,
        examples: usedLombok.flatMap((a) => (annotationCounts.get(a) ?? []).slice(0, 1)),
      });
    }

    // Detect error handling patterns
    this.detectErrorPatterns(patterns);

    // Detect DI pattern
    const allArgsCount = (annotationCounts.get("@AllArgsConstructor") ?? []).length;
    const autowiredCount = this.countPatternInFiles("@Autowired");
    if (allArgsCount > 5 && autowiredCount < allArgsCount) {
      patterns.push({
        name: "Constructor injection via Lombok",
        description: "@AllArgsConstructor + final fields for dependency injection (preferred over @Autowired field injection).",
        examples: (annotationCounts.get("@AllArgsConstructor") ?? []).slice(0, 2),
      });
    } else if (autowiredCount > 5) {
      patterns.push({
        name: "Mixed dependency injection",
        description: "Uses both @AllArgsConstructor constructor injection and @Autowired field injection. Prefer constructor injection for new code.",
        examples: [],
      });
    }

    // Detect test patterns
    this.detectTestPatterns(patterns);

    return patterns;
  }

  private detectErrorPatterns(patterns: CodePatternInsight[]): void {
    // Check for Either/Result pattern
    const eitherCount = this.countPatternInFiles("Either<");
    if (eitherCount > 3) {
      patterns.push({
        name: "Vavr Either for error handling",
        description: "Uses `io.vavr.control.Either<String, T>` for returning errors instead of throwing exceptions. Left = error message, Right = success value.",
        examples: [],
      });
    }

    // Check for Problem/RFC 7807
    const problemCount = this.countPatternInFiles("ProblemHandling");
    if (problemCount > 0) {
      patterns.push({
        name: "RFC 7807 Problem responses",
        description: "Uses Zalando problem-spring-web for structured error responses (application/problem+json). Exception handlers map domain exceptions to HTTP status codes.",
        examples: [],
      });
    }
  }

  private detectTestPatterns(patterns: CodePatternInsight[]): void {
    const testFiles = this.files.filter((f) =>
      f.includes("/test/") || f.includes("Test.java") || f.includes(".test.") || f.includes(".spec."),
    );
    if (testFiles.length === 0) return;

    // Sample a few test files
    let mockitoCount = 0;
    let truthCount = 0;
    let assertjCount = 0;
    let displayNameCount = 0;
    for (const file of testFiles.slice(0, 20)) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;
      try {
        const head = readFileSync(fullPath, "utf-8").slice(0, 2000);
        if (head.includes("MockitoExtension") || head.includes("@Mock")) mockitoCount++;
        if (head.includes("com.google.common.truth") || head.includes("Truth.assertThat")) truthCount++;
        if (head.includes("org.assertj") || head.includes("assertThat(")) assertjCount++;
        if (head.includes("ReplaceUnderscores") || head.includes("@DisplayNameGeneration")) displayNameCount++;
      } catch { /* skip */ }
    }

    const parts: string[] = [];
    if (mockitoCount > 2) parts.push("Mockito for mocking (@Mock + @InjectMocks)");
    if (truthCount > 2) parts.push("Google Truth for assertions (assertThat)");
    else if (assertjCount > 2) parts.push("AssertJ for assertions");
    if (displayNameCount > 2) parts.push("underscore method names with @DisplayNameGeneration(ReplaceUnderscores)");

    if (parts.length > 0) {
      patterns.push({
        name: "Test conventions",
        description: `Tests use: ${parts.join(", ")}.`,
        examples: testFiles.slice(0, 2),
      });
    }
  }

  private countPatternInFiles(pattern: string): number {
    let count = 0;
    // Sample top 30 most-changed source files
    const topFiles = [...this.changeFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([path]) => path);

    for (const file of topFiles) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, "utf-8").slice(0, 5000);
        if (content.includes(pattern)) count++;
      } catch { /* skip */ }
    }
    return count;
  }

  private scanTodoComments(): TodoComment[] {
    const todos: TodoComment[] = [];
    const patterns = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/;

    // Scan top 50 most-changed source files
    const topFiles = [...this.changeFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([path]) => path)
      .filter((f) => !f.includes("node_modules") && !f.includes(".min."));

    for (const file of topFiles) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;
      try {
        const lines = readFileSync(fullPath, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i]!.match(patterns);
          if (match) {
            todos.push({
              file,
              line: i + 1,
              type: match[1] as TodoComment["type"],
              text: match[2]!.trim().slice(0, 120),
            });
          }
        }
      } catch { /* skip */ }
      if (todos.length >= 30) break;
    }

    return todos;
  }

  private analyzeCommitPatterns(): CommitPatternInsight {
    const git = new GitReader(this.repoPath);
    if (!git.isGitRepo()) {
      return { style: "unknown", branchPattern: "", exampleMessages: [], mergeStrategy: "unknown", avgCommitsPerPR: 0 };
    }

    const commits = git.getCommits({ limit: 200, skipMerges: false });
    const nonMerge = commits.filter((c) => !c.isMerge);
    const mergeCommits = commits.filter((c) => c.isMerge);

    // Detect merge strategy from merge commit messages
    let mergeStrategy = "unknown";
    if (mergeCommits.length > 0) {
      const squashLike = mergeCommits.filter((c) => c.subject.includes("(#") && !c.subject.startsWith("Merge"));
      const mergeLike = mergeCommits.filter((c) => c.subject.startsWith("Merge pull request"));
      if (squashLike.length > mergeLike.length) mergeStrategy = "squash-merge";
      else if (mergeLike.length > 0) mergeStrategy = "merge-commit";
    }

    // Detect branch patterns from merge commits
    let branchPattern = "";
    const branchRefs = mergeCommits
      .map((c) => c.subject.match(/from \S+\/(\S+)/)?.[1])
      .filter(Boolean) as string[];
    if (branchRefs.length > 0) {
      const hasDevPrefix = branchRefs.some((b) => b.startsWith("dev_") || b.includes("/dev_"));
      const hasFeature = branchRefs.some((b) => b.startsWith("feature/") || b.includes("feature/"));
      if (hasFeature && hasDevPrefix) branchPattern = "feature/dev_<author>/<description> or feature/<description>";
      else if (hasFeature) branchPattern = "feature/<description>";
      else branchPattern = branchRefs.slice(0, 3).join(", ");
    }

    // Detect commit style
    let style = "free-form";
    const conventional = nonMerge.filter((c) => /^(feat|fix|docs|refactor|test|chore)\(/.test(c.subject)).length;
    const jira = nonMerge.filter((c) => /^[A-Z]{2,}-\d+/.test(c.subject)).length;
    if (conventional > nonMerge.length * 0.5) style = "conventional-commits";
    else if (jira > nonMerge.length * 0.3) style = "jira-prefixed";

    // Sample example messages (non-trivial ones)
    const exampleMessages = nonMerge
      .map((c) => c.subject)
      .filter((s) => s.length > 10 && !/^(fix|changes|logs|merge|fx)$/i.test(s.trim()))
      .slice(0, 5);

    // Avg commits per PR
    const prNumbers = mergeCommits
      .map((c) => c.subject.match(/#(\d+)/)?.[1])
      .filter(Boolean);
    const avgCommitsPerPR = prNumbers.length > 0 ? Math.round(nonMerge.length / prNumbers.length) : 0;

    return { style, branchPattern, exampleMessages, mergeStrategy, avgCommitsPerPR };
  }

  private extractProjectDescription(): string {
    // Try README.md first
    for (const name of ["README.md", "readme.md", "README.rst"]) {
      const readmePath = join(this.repoPath, name);
      if (existsSync(readmePath)) {
        try {
          const content = readFileSync(readmePath, "utf-8");
          // Extract first paragraph after the title
          const lines = content.split("\n");
          let pastTitle = false;
          const descLines: string[] = [];
          for (const line of lines) {
            if (!pastTitle && (line.startsWith("# ") || line.startsWith("==="))) {
              pastTitle = true;
              continue;
            }
            if (pastTitle) {
              if (line.trim() === "" && descLines.length > 0) break;
              if (line.trim() === "") continue;
              if (line.startsWith("#") || line.startsWith("---")) break;
              descLines.push(line.trim());
            }
          }
          if (descLines.length > 0) return descLines.join(" ").slice(0, 500);
        } catch { /* skip */ }
      }
    }

    // Try pom.xml <description>
    const pomPath = join(this.repoPath, "pom.xml");
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, "utf-8");
        const desc = content.match(/<description>(.*?)<\/description>/s)?.[1]?.trim();
        if (desc && desc.length > 5) return desc;
        // Try <name>
        const name = content.match(/<name>(.*?)<\/name>/)?.[1]?.trim();
        if (name && name.length > 3) return name;
      } catch { /* skip */ }
    }

    // Try package.json description
    const pkgPath = join(this.repoPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, string>;
        if (pkg.description) return pkg.description;
      } catch { /* skip */ }
    }

    return "";
  }

  /**
   * Detect team rules from code-review.rules, .cursor/rules/, .github/CODEOWNERS, etc.
   */
  private detectTeamRules(): string[] {
    const rules: string[] = [];

    // code-review.rules — extract just the descriptions as a concise list
    const crPath = join(this.repoPath, "code-review.rules");
    if (existsSync(crPath)) {
      try {
        const content = readFileSync(crPath, "utf-8");
        const descriptions = [...content.matchAll(/Description:\s*"(.+?)"/g)]
          .map((m) => `- ${m[1]}`)
          .slice(0, 15);
        if (descriptions.length > 0) {
          rules.push(`### Code Review Rules\n\n${descriptions.join("\n")}`);
        }
      } catch { /* skip */ }
    }

    // .cursor/rules/ directory
    const cursorRulesFiles = this.files.filter((f) => f.startsWith(".cursor/rules/"));
    for (const file of cursorRulesFiles.slice(0, 3)) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, "utf-8").trim();
        if (content.length > 0) {
          // Strip frontmatter if present
          const cleaned = content.replace(/^---[\s\S]*?---\s*/, "").trim();
          rules.push(`### AI Working Rules (${basename(file)})\n\n${cleaned.slice(0, 1500)}`);
        }
      } catch { /* skip */ }
    }

    return rules;
  }

  /**
   * Parse docker-compose.yml to extract service map with ports.
   */
  private parseDockerCompose(): ServiceInfo[] {
    const services: ServiceInfo[] = [];
    // Find docker-compose files (may be nested)
    const composeFiles = this.files.filter((f) =>
      f.includes("docker-compose") && (f.endsWith(".yml") || f.endsWith(".yaml")),
    );
    // Also check for non-tracked docker-compose in known locations
    for (const candidate of ["docker-compose.yml", "docker-compose.yaml"]) {
      if (!composeFiles.includes(candidate) && existsSync(join(this.repoPath, candidate))) {
        composeFiles.push(candidate);
      }
    }

    // Prefer non-staging docker-compose files
    composeFiles.sort((a, b) => {
      const aStaging = a.includes("staging") ? 1 : 0;
      const bStaging = b.includes("staging") ? 1 : 0;
      return aStaging - bStaging;
    });
    for (const file of composeFiles.slice(0, 2)) {
      const fullPath = join(this.repoPath, file);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        let inServices = false;
        let serviceIndent = -1;
        let currentService = "";
        let inPorts = false;
        let inDependsOn = false;

        for (const line of lines) {
          if (/^services:\s*$/.test(line)) {
            inServices = true;
            continue;
          }
          if (!inServices) continue;
          if (/^\S/.test(line) && !line.startsWith("#")) break; // Left services block

          // Detect service-level indent (first non-comment indented key under services:)
          const keyMatch = line.match(/^(\s+)(\w[\w-]*):/);
          if (!keyMatch) {
            // List item under ports or depends_on
            if (currentService) {
              const listItem = line.match(/^\s+-\s+(.+)/);
              if (listItem) {
                if (inPorts) {
                  const portMatch = listItem[1]!.match(/["']?(\d{4,5}):\d{4,5}["']?/);
                  if (portMatch) {
                    const svc = services.find((s) => s.name === currentService);
                    if (svc && !svc.port) svc.port = portMatch[1]!;
                  }
                }
                if (inDependsOn) {
                  const dep = listItem[1]!.trim().replace(/["']/g, "");
                  if (/^[\w-]+$/.test(dep)) {
                    services.find((s) => s.name === currentService)?.dependsOn.push(dep);
                  }
                }
              }
            }
            continue;
          }

          const indent = keyMatch[1]!.length;
          const key = keyMatch[2]!;

          // First service key determines service indent level
          if (serviceIndent < 0) serviceIndent = indent;

          if (indent === serviceIndent) {
            // This is a service name
            currentService = key;
            inPorts = false;
            inDependsOn = false;
            if (!services.find((s) => s.name === currentService)) {
              services.push({ name: currentService, dependsOn: [] });
            }
          } else if (indent > serviceIndent && currentService) {
            // Property of current service
            inPorts = key === "ports";
            inDependsOn = key === "depends_on";
            if (key !== "ports" && key !== "depends_on") {
              inPorts = false;
              inDependsOn = false;
            }
          }
        }
      } catch { /* skip */ }
      if (services.length > 0) break;
    }

    return services;
  }
}

import type { RepositoryAnalysis, GeneratedFile } from "../types.js";
import {
  renderReviewerAgent,
  renderTestWriterAgent,
  renderDocMaintainerAgent,
  renderSecurityAuditorAgent,
} from "./templates.js";

interface AgentTemplate {
  filename: string;
  condition: (analysis: RepositoryAnalysis) => boolean;
  render: (analysis: RepositoryAnalysis) => string;
}

const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    filename: "reviewer.md",
    condition: () => true,
    render: renderReviewerAgent,
  },
  {
    filename: "test-writer.md",
    condition: (a) => a.testFrameworks.length > 0,
    render: renderTestWriterAgent,
  },
  {
    filename: "doc-maintainer.md",
    condition: () => true,
    render: renderDocMaintainerAgent,
  },
  {
    filename: "security-auditor.md",
    condition: () => true,
    render: renderSecurityAuditorAgent,
  },
];

export class AgentBuilder {
  constructor(
    private readonly repoPath: string,
    private readonly analysis: RepositoryAnalysis,
  ) {}

  async buildAll(): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];

    for (const template of AGENT_TEMPLATES) {
      if (template.condition(this.analysis)) {
        files.push({
          path: `.claude/agents/${template.filename}`,
          content: template.render(this.analysis),
          action: "created",
        });
      }
    }

    return files;
  }
}

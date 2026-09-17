import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

interface Step {
  name?: string;
  id?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
}

interface Job {
  name?: string;
  'runs-on'?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  on?: {
    push?: {
      tags?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs?: {
    release?: Job;
  };
}

function readReleaseWorkflow(): Workflow | undefined {
  const workflowPath = path.resolve(import.meta.dir, '../.github/workflows/release.yml');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(workflowPath)) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return Bun.YAML.parse(fs.readFileSync(workflowPath, 'utf8')) as Workflow;
}

function readChangelog(): string {
  const changelogPath = path.resolve(import.meta.dir, '../CHANGELOG.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(changelogPath)) return '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs.readFileSync(changelogPath, 'utf8');
}

function readReadme(): string {
  const readmePath = path.resolve(import.meta.dir, '../README.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  if (!fs.existsSync(readmePath)) return '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
  return fs.readFileSync(readmePath, 'utf8');
}

describe('Release workflow', () => {
  it('workflow file exists and is valid YAML', () => {
    const workflow = readReleaseWorkflow();
    expect(workflow).toBeDefined();
    expect(workflow?.name).toBe('Release');
  });

  it('triggers on version tag push', () => {
    const workflow = readReleaseWorkflow();
    const tags = workflow?.on?.push?.tags ?? [];
    expect(tags.some((tag) => tag === 'v*' || tag.startsWith('v'))).toBe(true);
  });

  it('declares id-token: write permission for provenance', () => {
    const workflow = readReleaseWorkflow();
    const workflowPerms = workflow?.permissions ?? {};
    const releaseJob = workflow?.jobs?.release;
    const jobPerms = releaseJob?.permissions ?? {};
    const idTokenPerm = workflowPerms['id-token'] ?? jobPerms['id-token'];
    expect(idTokenPerm).toBe('write');
  });

  it('runs build step', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const buildStep = steps.find((s) => (s.run ?? '').includes('bun run build'));
    expect(buildStep).toBeDefined();
  });

  it('runs test step', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const testStep = steps.find((s) => (s.run ?? '').includes('bun run test'));
    expect(testStep).toBeDefined();
  });

  it('extracts release notes and drafts GitHub release', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const draftStep = steps.find(
      (s) => (s.run ?? '').includes('gh release create') && (s.run ?? '').includes('--draft')
    );
    expect(draftStep).toBeDefined();
  });

  it('does not swallow a failed release draft', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const draftStep = steps.find((s) => (s.run ?? '').includes('gh release create'));
    expect(draftStep).toBeDefined();
    // `|| true` (or any `|| …` fallback) would let a bad token, an existing
    // release or a network failure pass as success with no release drafted.
    expect(draftStep?.run).not.toMatch(/\|\|/);
    expect(draftStep?.['continue-on-error']).toBeUndefined();
  });

  it('includes visible notice when NPM_TOKEN is not configured', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const notifyStep = steps.find(
      (s) => (s.if ?? '').includes('secrets.NPM_TOKEN') && /skipped|pending/i.test(s.run ?? '')
    );
    expect(notifyStep).toBeDefined();
    expect(notifyStep?.run).toMatch(/pending NPM_TOKEN|NPM_TOKEN/);
  });

  it('gates npm publish on NPM_TOKEN rather than running unconditionally', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const publishStep = steps.find((s) =>
      (s.run ?? '').split('\n').some((line) => line.trimStart().startsWith('npm publish'))
    );
    expect(publishStep).toBeDefined();
    expect(publishStep?.if).toBeDefined();
    expect(publishStep?.if).toContain('secrets.NPM_TOKEN');
  });

  it('includes provenance flag on npm publish', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const publishStep = steps.find((s) =>
      (s.run ?? '').split('\n').some((line) => line.trimStart().startsWith('npm publish'))
    );
    expect(publishStep?.run).toContain('--provenance');
  });
});

describe('Changelog', () => {
  it('CHANGELOG.md exists with initial entry', () => {
    const changelog = readChangelog();
    expect(changelog.length).toBeGreaterThan(0);
    expect(changelog).toContain('[0.1.0]');
  });
});

describe('Release documentation', () => {
  it('documents semantic versioning and schema changes as major bumps', () => {
    const readme = readReadme();
    expect(readme).toMatch(/major (version )?bump/i);
  });

  it('documents changelog maintenance', () => {
    const readme = readReadme();
    expect(readme).toMatch(/CHANGELOG\.md/);
  });

  it('documents npm publish pending NPM_TOKEN setup', () => {
    const readme = readReadme();
    expect(readme).toMatch(/NPM_TOKEN/);
  });
});

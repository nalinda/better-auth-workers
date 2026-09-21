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
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}

interface Job {
  name?: string;
  'runs-on'?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
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

// What the publish branches are gated on: a boolean output rather than the
// token itself, so the secret stays out of every step that does not publish.
const TOKEN_GATE = 'steps.npm-auth.outputs.configured';

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

  it('fails before drafting or publishing when the tag does not match package.json', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const guardIndex = steps.findIndex(
      (s) => (s.run ?? '').includes('GITHUB_REF_NAME') && (s.run ?? '').includes('package.json')
    );
    const draftIndex = steps.findIndex((s) => (s.run ?? '').includes('gh release create'));
    const publishIndex = steps.findIndex((s) =>
      (s.run ?? '').split('\n').some((line) => line.trimStart().startsWith('npm publish'))
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(draftIndex);
    expect(guardIndex).toBeLessThan(publishIndex);
    const guardStep = steps.at(guardIndex);
    expect(guardStep?.run).toMatch(/exit 1/);
    expect(guardStep?.run).toMatch(/version/i);
    expect(guardStep?.if).toBeUndefined();
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

  // The two branches of the token gate must be complementary: exactly one
  // of "annotate the run that publishing was skipped" and "publish" fires,
  // decided by whether env.NPM_TOKEN is set, and the skip branch surfaces
  // as a GitHub Actions annotation (`::notice`), not just a log line.
  it('when NPM_TOKEN is empty, a step emits a notice annotation instead of publishing', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const skipStep = steps.find((s) => (s.if ?? '').includes(`${TOKEN_GATE} != 'true'`));
    expect(skipStep).toBeDefined();
    const skipLines = (skipStep?.run ?? '').split('\n').map((line) => line.trim());
    expect(skipLines.some((line) => line.startsWith('echo "::notice'))).toBe(true);
    expect(skipLines.some((line) => line.startsWith('npm publish'))).toBe(false);

    const publishStep = steps.find((s) =>
      (s.run ?? '').split('\n').some((line) => line.trimStart().startsWith('npm publish'))
    );
    expect(publishStep?.if).toContain(`${TOKEN_GATE} == 'true'`);
  });

  // GitHub Actions does not expose `secrets` in a step-level `if:`; such a
  // condition fails to evaluate and the whole job errors on the first tag.
  // One step therefore reduces the secret to a boolean output, and the two
  // branches gate on that.
  it('gates the publish branches on a boolean output, never on secrets in a step condition', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const gateStep = steps.find((s) => s.id === 'npm-auth');
    expect(gateStep?.env?.NPM_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(gateStep?.run).toContain('GITHUB_OUTPUT');

    const gated = steps.filter((s) => (s.if ?? '').includes('npm-auth'));
    expect(gated.length).toBeGreaterThanOrEqual(2);
    for (const step of gated) {
      expect(step.if).toContain(TOKEN_GATE);
      expect(step.if).not.toMatch(/secrets\./);
    }
  });

  // The token was previously mapped at job level, so it sat in the
  // environment of `bun install` (which runs a `prepare` script), the build
  // and the test run — none of which publish anything.
  it('never puts the npm token in the environment of a step that is not publishing', () => {
    const workflow = readReleaseWorkflow();
    const job = workflow?.jobs?.release;
    expect(job?.env?.NPM_TOKEN).toBeUndefined();
    expect(job?.env?.NODE_AUTH_TOKEN).toBeUndefined();

    const tokenSteps = (job?.steps ?? []).filter((s) =>
      Object.values(s.env ?? {}).some((value) => value.includes('secrets.NPM_TOKEN'))
    );
    expect(tokenSteps.length).toBeGreaterThan(0);
    for (const step of tokenSteps) {
      const isGateStep = step.id === 'npm-auth';
      expect(isGateStep || (step.if ?? '').includes(TOKEN_GATE)).toBe(true);
    }
    const names = tokenSteps.map((s) => s.name);
    expect(names).not.toContain('Build');
    expect(names).not.toContain('Test');
  });

  // Nothing in this job pushes, so the checkout token should not be left in
  // .git/config for every later step to pick up.
  it('checks out without persisting the checkout credentials', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const checkoutSteps = steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout'));
    expect(checkoutSteps.length).toBeGreaterThan(0);
    for (const step of checkoutSteps) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('gates npm publish on the token rather than running unconditionally', () => {
    const workflow = readReleaseWorkflow();
    const steps = workflow?.jobs?.release?.steps ?? [];
    const publishStep = steps.find((s) =>
      (s.run ?? '').split('\n').some((line) => line.trimStart().startsWith('npm publish'))
    );
    expect(publishStep).toBeDefined();
    expect(publishStep?.if).toBeDefined();
    expect(publishStep?.if).toContain(TOKEN_GATE);
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

describe('npm provenance prerequisites', () => {
  it('package.json names the repository the provenance attestation is checked against', () => {
    const pkgPath = path.resolve(import.meta.dir, '../package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      repository?: { type?: string; url?: string };
      homepage?: string;
      bugs?: { url?: string };
    };
    expect(pkg.repository?.type).toBe('git');
    expect(pkg.repository?.url).toMatch(
      /^git\+https:\/\/github\.com\/[^/]+\/better-auth-workers\.git$/
    );
    expect(pkg.homepage).toMatch(/github\.com/);
    expect(pkg.bugs?.url).toMatch(/\/issues$/);
  });
});

describe('Changelog', () => {
  it('CHANGELOG.md keeps an [Unreleased] heading for work after the latest release', () => {
    const changelog = readChangelog();
    expect(changelog.length).toBeGreaterThan(0);
    expect(changelog).toContain('## [Unreleased]');
  });

  it('CHANGELOG.md records a dated heading for the latest released version', () => {
    const changelog = readChangelog();
    expect(changelog).toMatch(/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/m);
  });
});

describe('Release documentation', () => {
  it('documents semantic versioning and schema changes as major bumps', () => {
    const readme = readReadme();
    expect(readme).toMatch(/major (version )?bump/i);
  });
});

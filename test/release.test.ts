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
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
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
  jobs?: Record<string, Job | undefined>;
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

function jobOf(name: 'build' | 'check-tarball' | 'release'): Job | undefined {
  return new Map(Object.entries(readReleaseWorkflow()?.jobs ?? {})).get(name);
}

function stepsOf(name: 'build' | 'check-tarball' | 'release'): Step[] {
  return jobOf(name)?.steps ?? [];
}

function needsOf(job: Job | undefined): string[] {
  const needs = job?.needs ?? [];
  return typeof needs === 'string' ? [needs] : needs;
}

function allJobs(): Job[] {
  return Object.values(readReleaseWorkflow()?.jobs ?? {}).filter(
    (job): job is Job => job !== undefined
  );
}

function isRunning(step: Step, command: string): boolean {
  return (step.run ?? '').split('\n').some((line) => line.trimStart().startsWith(command));
}

const PACKED_TARBALL = '${{ needs.build.outputs.tarball }}';

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

  it('builds and tests before packing', () => {
    const steps = stepsOf('build');
    const buildIndex = steps.findIndex((s) => (s.run ?? '').includes('bun run build'));
    const testIndex = steps.findIndex((s) => (s.run ?? '').includes('bun run test'));
    const packIndex = steps.findIndex((s) => s.id === 'pack');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(-1);
    expect(packIndex).toBeGreaterThan(buildIndex);
    expect(packIndex).toBeGreaterThan(testIndex);
  });

  it('fails before drafting or publishing when the tag does not match package.json', () => {
    const steps = stepsOf('build');
    const guardIndex = steps.findIndex(
      (s) => (s.run ?? '').includes('GITHUB_REF_NAME') && (s.run ?? '').includes('package.json')
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(steps.findIndex((s) => s.id === 'pack'));
    const guardStep = steps.at(guardIndex);
    expect(guardStep?.run).toMatch(/exit 1/);
    expect(guardStep?.run).toMatch(/version/i);
    expect(guardStep?.if).toBeUndefined();
    // Drafting and publishing live in the release job, which cannot start
    // until the build job (and so the guard) has succeeded.
    expect(needsOf(jobOf('release'))).toContain('build');
  });

  it('extracts release notes and drafts GitHub release', () => {
    const draftStep = stepsOf('release').find(
      (s) => (s.run ?? '').includes('gh release create') && (s.run ?? '').includes('--draft')
    );
    expect(draftStep).toBeDefined();
  });

  it('does not swallow a failed release draft', () => {
    const draftStep = stepsOf('release').find((s) => (s.run ?? '').includes('gh release create'));
    expect(draftStep).toBeDefined();
    // `|| true` (or any `|| …` fallback) would let a bad token, an existing
    // release or a network failure pass as success with no release drafted.
    expect(draftStep?.run).not.toMatch(/\|\|/);
    expect(draftStep?.['continue-on-error']).toBeUndefined();
  });

  // Consumers pin the tarball attached to the GitHub release, so the release
  // must carry the same bytes npm would serve, checked before anything ships.
  it('packs exactly once, from the locked build job, recording a checksum', () => {
    const packSteps = allJobs()
      .flatMap((job) => job.steps ?? [])
      .filter((s) => (s.run ?? '').includes('npm pack'));
    expect(packSteps).toHaveLength(1);
    const packStep = stepsOf('build').find((s) => s.id === 'pack');
    expect(packStep).toEqual(packSteps.at(0));
    expect(packStep?.run).toContain('npm pack --ignore-scripts');
    expect(packStep?.run).toContain('sha256sum');
    expect(jobOf('build')?.outputs?.sha256).toBe('${{ steps.pack.outputs.sha256 }}');
    expect(jobOf('build')?.outputs?.tarball).toBe('${{ steps.pack.outputs.tarball }}');
  });

  // Installing into a fresh consumer resolves better-auth's dependencies from
  // the registry with no lockfile, and runs them. That must not happen in a
  // job that can write releases or mint an OIDC token.
  it('checks the tarball installs in a separate job with read-only permissions', () => {
    const job = jobOf('check-tarball');
    expect(needsOf(job)).toContain('build');
    expect(job?.permissions).toEqual({ contents: 'read' });
    const check = (job?.steps ?? []).find((s) =>
      (s.run ?? '').includes('scripts/check-packed-install.sh')
    );
    expect(check?.env?.TARBALL).toBe(PACKED_TARBALL);
  });

  it('grants write and id-token permissions only to the release job', () => {
    const workflow = readReleaseWorkflow();
    expect(workflow?.permissions).toEqual({ contents: 'read' });
    expect(jobOf('build')?.permissions).toEqual({ contents: 'read' });
    expect(jobOf('release')?.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  });

  // A frozen install trusts a restored node_modules as is, so a cache that
  // any job running unlocked code could have written must never feed the
  // build that is shipped, nor be written to by the unlocked check.
  it('uses no shared dependency cache in any release job', () => {
    for (const job of allJobs()) {
      const steps = job.steps ?? [];
      for (const step of steps) {
        expect(step.uses ?? '').not.toContain('bun-install');
        expect(step.uses ?? '').not.toMatch(/^actions\/cache/);
      }
    }
    for (const name of ['build', 'check-tarball'] as const) {
      expect(stepsOf(name).some((s) => isRunning(s, 'bun install --frozen-lockfile'))).toBe(true);
    }
  });

  it('runs no dependency code in the release job', () => {
    for (const step of stepsOf('release')) {
      expect(step.uses ?? '').not.toContain('bun-install');
      expect(step.uses ?? '').not.toContain('setup-bun');
      for (const command of ['bun ', 'bunx', 'npm install', 'npm ci', 'npx']) {
        expect(isRunning(step, command)).toBe(false);
      }
    }
  });

  it('releases only a tarball that was checked and whose checksum is unchanged', () => {
    const job = jobOf('release');
    expect(needsOf(job)).toContain('build');
    expect(needsOf(job)).toContain('check-tarball');
    const steps = job?.steps ?? [];
    const verifyIndex = steps.findIndex((s) => (s.run ?? '').includes('sha256sum --check'));
    const draftIndex = steps.findIndex((s) => (s.run ?? '').includes('gh release create'));
    const publishIndex = steps.findIndex((s) => isRunning(s, 'npm publish'));
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(draftIndex);
    expect(verifyIndex).toBeLessThan(publishIndex);
    expect(steps.at(verifyIndex)?.env?.EXPECTED_SHA256).toBe('${{ needs.build.outputs.sha256 }}');

    const draftStep = steps.at(draftIndex);
    expect(draftStep?.env?.TARBALL).toBe(PACKED_TARBALL);
    expect(draftStep?.run).toContain('"$TARBALL"');
  });

  it('publishes to npm the same tarball it attached to the release', () => {
    const publishStep = stepsOf('release').find((s) => isRunning(s, 'npm publish'));
    expect(publishStep?.env?.TARBALL).toBe(PACKED_TARBALL);
    expect(publishStep?.run).toContain('npm publish "$TARBALL"');
  });

  // The two branches of the token gate must be complementary: exactly one
  // of "annotate the run that publishing was skipped" and "publish" fires,
  // decided by whether env.NPM_TOKEN is set, and the skip branch surfaces
  // as a GitHub Actions annotation (`::notice`), not just a log line.
  it('when NPM_TOKEN is empty, a step emits a notice annotation instead of publishing', () => {
    const steps = stepsOf('release');
    const skipStep = steps.find((s) => (s.if ?? '').includes(`${TOKEN_GATE} != 'true'`));
    expect(skipStep).toBeDefined();
    const skipLines = (skipStep?.run ?? '').split('\n').map((line) => line.trim());
    expect(skipLines.some((line) => line.startsWith('echo "::notice'))).toBe(true);
    expect(skipLines.some((line) => line.startsWith('npm publish'))).toBe(false);

    const publishStep = steps.find((s) => isRunning(s, 'npm publish'));
    expect(publishStep?.if).toContain(`${TOKEN_GATE} == 'true'`);
  });

  // GitHub Actions does not expose `secrets` in a step-level `if:`; such a
  // condition fails to evaluate and the whole job errors on the first tag.
  // One step therefore reduces the secret to a boolean output, and the two
  // branches gate on that.
  it('gates the publish branches on a boolean output, never on secrets in a step condition', () => {
    const steps = stepsOf('release');
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

  // The token must never sit in the environment of `bun install` (which runs
  // a `prepare` script), the build or the test run — none of which publish.
  it('never puts the npm token in the environment of a step that is not publishing', () => {
    for (const job of allJobs()) {
      expect(job.env?.NPM_TOKEN).toBeUndefined();
      expect(job.env?.NODE_AUTH_TOKEN).toBeUndefined();
    }
    for (const name of ['build', 'check-tarball'] as const) {
      const leaks = stepsOf(name).filter((s) =>
        Object.values(s.env ?? {}).some((value) => value.includes('secrets.NPM_TOKEN'))
      );
      expect(leaks).toEqual([]);
    }

    const tokenSteps = stepsOf('release').filter((s) =>
      Object.values(s.env ?? {}).some((value) => value.includes('secrets.NPM_TOKEN'))
    );
    expect(tokenSteps.length).toBeGreaterThan(0);
    for (const step of tokenSteps) {
      const isGateStep = step.id === 'npm-auth';
      expect(isGateStep || (step.if ?? '').includes(TOKEN_GATE)).toBe(true);
    }
  });

  // Nothing in this workflow pushes, so the checkout token should not be
  // left in .git/config for every later step to pick up.
  it('checks out without persisting the checkout credentials', () => {
    const checkoutSteps = allJobs()
      .flatMap((job) => job.steps ?? [])
      .filter((s) => (s.uses ?? '').startsWith('actions/checkout'));
    expect(checkoutSteps).toHaveLength(3);
    for (const step of checkoutSteps) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('includes provenance flag on npm publish', () => {
    const publishStep = stepsOf('release').find((s) => isRunning(s, 'npm publish'));
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

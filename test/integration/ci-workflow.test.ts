import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

interface Step {
  run?: string;
  env?: Record<string, string>;
}

interface Job {
  services?: Record<string, { image?: string }>;
  steps?: Step[];
  env?: Record<string, string>;
}

interface Workflow {
  jobs?: Record<string, Job>;
}

const workflowPath = path.resolve(import.meta.dir, '../../.github/workflows/ci.yml');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path
const workflow = Bun.YAML.parse(fs.readFileSync(workflowPath, 'utf8')) as Workflow;
const jobs = Object.values(workflow.jobs ?? {});

function integrationJobs(): Job[] {
  return jobs.filter((job) =>
    (job.steps ?? []).some((step) => /test\/integration|test:integration/.test(step.run ?? ''))
  );
}

function backendsRun(job: Job): string {
  return [
    ...Object.values(job.env ?? {}),
    ...(job.steps ?? []).flatMap((step) => [step.run ?? '', ...Object.values(step.env ?? {})]),
  ].join('\n');
}

describe('CI runs the wrangler dev integration suite', () => {
  it('has a job that runs the integration suite', () => {
    expect(integrationJobs().length).toBeGreaterThan(0);
  });

  it('runs the hyperdrive backend against a Postgres service container', () => {
    const job = integrationJobs().find((candidate) => /hyperdrive/.test(backendsRun(candidate)));
    expect(job).toBeDefined();
    const images = Object.values(job?.services ?? {}).map((service) => service.image ?? '');
    expect(images.some((image) => image.startsWith('postgres'))).toBe(true);
  });

  it('runs the d1 backend', () => {
    const job = integrationJobs().find((candidate) => /\bd1\b/.test(backendsRun(candidate)));
    expect(job).toBeDefined();
  });
});

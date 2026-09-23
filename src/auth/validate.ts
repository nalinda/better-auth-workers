import type { AuthEnv } from '../types';
import { verificationStorageProblem } from './config';
import { databaseProblem } from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { kvProblem } from './kv';
import { googleCredentialProblems } from './plugins/google';
import { testModeProblems } from './test-mode';
import type { CreateAuthOptions } from './types';

// Better Auth hands a sendOTP that returns a promise to its background task
// handler instead of awaiting it, which would undo awaitDelivery.
function awaitDeliveryProblem(options?: CreateAuthOptions): string | undefined {
  if (!options?.phone?.awaitDelivery || !options.betterAuth?.advanced?.backgroundTasks?.handler) {
    return;
  }
  return 'phone.awaitDelivery cannot be combined with betterAuth.advanced.backgroundTasks: Better Auth runs sendOTP as a background task then, so its failure never reaches the response';
}

function idTypeProblem(options?: CreateAuthOptions): string | undefined {
  const idType: unknown = options?.idType;
  const accepted: unknown[] = [undefined, 'text', 'uuid'];
  if (accepted.includes(idType)) return;
  return `idType must be "text" or "uuid", got ${JSON.stringify(idType)}`;
}

function collectConfigProblems(options?: CreateAuthOptions, env?: Partial<AuthEnv>): string[] {
  const problems: string[] = [];

  if (resolveBaseURL(options, env) === undefined) {
    problems.push('baseURL is required: specify options.baseURL or env.AUTH_BASE_URL');
  }
  if (resolveSecret(options, env) === undefined) {
    problems.push('secret is required: specify options.secret or env.BETTER_AUTH_SECRET');
  }
  const single = [
    awaitDeliveryProblem(options),
    databaseProblem(options, env),
    kvProblem(options, env),
    verificationStorageProblem(options),
    idTypeProblem(options),
  ].filter((problem) => problem !== undefined);
  problems.push(
    ...single,
    ...googleCredentialProblems(options, env),
    ...testModeProblems(options, env)
  );

  return problems;
}

export function validateConfig(options?: CreateAuthOptions, env?: Partial<AuthEnv>): void {
  const problems = collectConfigProblems(options, env);
  if (problems.length === 0) return;
  const suffix = problems.length === 1 ? '' : 's';
  const list = problems.map((problem) => `- ${problem}`).join('\n');
  throw new Error(
    `better-auth-workers: invalid configuration (${problems.length} problem${suffix}):\n${list}`
  );
}

import type { AuthEnv } from '../types';
import { verificationStorageProblem } from './config';
import { databaseProblem } from './database';
import { resolveBaseURL, resolveSecret } from './env';
import { kvProblem } from './kv';
import { googleCredentialProblems } from './plugins/google';
import { testModeProblems } from './test-mode';
import type { CreateAuthOptions } from './types';

function collectConfigProblems(options?: CreateAuthOptions, env?: Partial<AuthEnv>): string[] {
  const problems: string[] = [];

  if (resolveBaseURL(options, env) === undefined) {
    problems.push('baseURL is required: specify options.baseURL or env.AUTH_BASE_URL');
  }
  if (resolveSecret(options, env) === undefined) {
    problems.push('secret is required: specify options.secret or env.BETTER_AUTH_SECRET');
  }
  // Better Auth hands a sendOTP that returns a promise to its background
  // task handler instead of awaiting it, which would undo awaitDelivery.
  if (options?.phone?.awaitDelivery && options.betterAuth?.advanced?.backgroundTasks?.handler) {
    problems.push(
      'phone.awaitDelivery cannot be combined with betterAuth.advanced.backgroundTasks: Better Auth runs sendOTP as a background task then, so its failure never reaches the response'
    );
  }
  const dbProblem = databaseProblem(options, env);
  if (dbProblem) problems.push(dbProblem);
  const kvMissing = kvProblem(options, env);
  if (kvMissing) problems.push(kvMissing);
  const verificationProblem = verificationStorageProblem(options);
  if (verificationProblem) problems.push(verificationProblem);
  problems.push(...googleCredentialProblems(options, env), ...testModeProblems(options, env));
  const idType: unknown = options?.idType;
  if (idType !== undefined && idType !== 'text' && idType !== 'uuid') {
    problems.push(`idType must be "text" or "uuid", got ${JSON.stringify(idType)}`);
  }

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

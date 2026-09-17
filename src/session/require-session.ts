import type { SessionHandler } from './types';

const noopSessionHandler: SessionHandler = () => Promise.resolve();

export function requireSession(): SessionHandler {
  return noopSessionHandler;
}

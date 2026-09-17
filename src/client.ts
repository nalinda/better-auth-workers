export interface SessionClient {
  get: (request: Request) => Promise<Record<string, string> | null>;
}

export type SessionHandler = () => Promise<void>;

const noopSessionHandler: SessionHandler = () => Promise.resolve();

export function createSessionClient(): SessionClient {
  return {
    get: () => Promise.resolve(null),
  };
}

export function requireSession(): SessionHandler {
  return noopSessionHandler;
}

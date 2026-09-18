import net from 'node:net';

// A TCP proxy in front of Postgres that counts the statements the Worker
// sends: every simple query (`Q`) and every prepared-statement parse (`P`)
// on the frontend side of the wire. This is how the Hyperdrive backend gets
// a primary-store query counter without touching the example Worker or the
// pg driver it bundles.
export interface PostgresProxy {
  connectionString: string;
  statements: () => number;
  close: () => Promise<void>;
}

const SSL_REQUEST_CODE = 80_877_103;
const GSSENC_REQUEST_CODE = 80_877_104;
const STATEMENT_MESSAGE_TYPES = new Set([0x51, 0x50]); // 'Q', 'P'

// Frontend messages are `<type byte><int32 length><payload>` once the
// connection is established. Before that, the client sends length-prefixed
// messages with no type byte: optionally an SSL/GSS request (answered with
// one byte), then the startup message.
function createStatementCounter(onStatement: () => void): (chunk: Uint8Array) => void {
  let buffer = new Uint8Array(0);
  let isStarted = false;

  const readInt32 = (offset: number): number =>
    new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(offset);

  const didConsumeStartupMessage = (): boolean => {
    if (buffer.length < 8) return false;
    const length = readInt32(0);
    if (buffer.length < length) return false;
    const code = readInt32(4);
    if (code !== SSL_REQUEST_CODE && code !== GSSENC_REQUEST_CODE) isStarted = true;
    buffer = buffer.subarray(length);
    return true;
  };

  const didConsumeTypedMessage = (): boolean => {
    if (buffer.length < 5) return false;
    const type = buffer[0];
    const length = readInt32(1);
    if (buffer.length < 1 + length) return false;
    if (STATEMENT_MESSAGE_TYPES.has(type)) onStatement();
    buffer = buffer.subarray(1 + length);
    return true;
  };

  return (chunk: Uint8Array) => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    while (isStarted ? didConsumeTypedMessage() : didConsumeStartupMessage()) {
      // keep draining complete messages
    }
  };
}

export function startPostgresProxy(upstreamConnectionString: string): Promise<PostgresProxy> {
  const upstream = new URL(upstreamConnectionString);
  const upstreamPort = Number(upstream.port || 5432);
  const upstreamHost = upstream.hostname;
  let statements = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const target = net.connect(upstreamPort, upstreamHost);
    sockets.add(client);
    sockets.add(target);
    const count = createStatementCounter(() => {
      statements += 1;
    });
    client.on('data', (chunk: Uint8Array) => {
      count(chunk);
      target.write(chunk);
    });
    target.on('data', (chunk: Uint8Array) => {
      client.write(chunk);
    });
    const closeBoth = () => {
      client.destroy();
      target.destroy();
      sockets.delete(client);
      sockets.delete(target);
    };
    client.on('close', closeBoth);
    target.on('close', closeBoth);
    client.on('error', closeBoth);
    target.on('error', closeBoth);
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a port for the postgres proxy'));
        return;
      }
      const proxied = new URL(upstreamConnectionString);
      proxied.hostname = '127.0.0.1';
      proxied.port = String(address.port);
      resolve({
        connectionString: proxied.href,
        statements: () => statements,
        close,
      });
    });
  });
}

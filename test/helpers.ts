import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

export const SCRATCH_BASE = os.tmpdir();
export const KEY_A = "test-key-a";
export const KEY_B = "test-key-b";
export const LABEL_A = "go-1";
export const LABEL_B = "go-2";

export function genToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH_BASE, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function writeKeysFile(
  dir: string,
  keys: Array<{ label: string; key: string }>,
  mode = 0o600,
): string {
  const file = path.join(dir, `keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ keys }, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

export function overwriteKeysFile(file: string, data: unknown): void {
  fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
}

export function writeTokenFile(dir: string, token: string, mode = 0o600): string {
  const file = path.join(dir, `token-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, `${token}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

/** Remove only the exact files we created, then the (now empty) dir. Never recursive. */
export function cleanupScratchDir(dir: string, files: string[]): void {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // leave for inspection if not empty; never rm -rf
  }
}

export type RecordedHit = {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export function startFakeUpstream(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse, hit: RecordedHit) => void,
): Promise<{
  server: http.Server;
  port: number;
  hits: RecordedHit[];
  close: () => Promise<void>;
}> {
  const hits: RecordedHit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit: RecordedHit = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      };
      hits.push(hit);
      onRequest(req, res, hit);
    });
    req.on("error", () => {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        hits,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

export function listenGateway(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

export function gatewayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function readJsonBody(res: Response): Promise<any> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T | PromiseLike<T>) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

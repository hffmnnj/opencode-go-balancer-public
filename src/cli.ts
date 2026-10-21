import { homedir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./gateway.ts";

const directory = join(homedir(), ".config/opencode-v2/opencode-go-balancer");
const port = Number(process.env.GO_BALANCER_PORT ?? "4790");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid gateway port");
try {
  const gateway = createGateway({
    keysPath: process.env.GO_BALANCER_KEYS ?? join(directory, "keys.json"),
    tokenPath: process.env.GO_BALANCER_TOKEN_FILE ?? join(directory, "local-token"),
  });
  gateway.server.on("error", () => { console.error("Gateway listener unavailable"); void gateway.close(); process.exitCode = 1; });
  gateway.server.listen(port, "127.0.0.1", () => {
    const address = gateway.server.address();
    console.log(`Go gateway listening on 127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
  });
  process.on("SIGHUP", () => { gateway.reloadKeys(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void gateway.close(); });
} catch {
  console.error("Gateway initialization failed; check private configuration files");
  process.exitCode = 1;
}

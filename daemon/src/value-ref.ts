import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Resolve a valueRef string to its plaintext value.
 * Never log the returned value. Caller is responsible for scrubbing.
 *
 * Supported schemes:
 *   vault://<path>               — vault.etzhayyim.com (Phase 4 wiring)
 *   keychain:<service>/<account>[.<jsonKey>]
 *                                — macOS Keychain `security find-generic-password`
 *                                  If value is JSON and `.jsonKey` supplied,
 *                                  return the jsonKey field.
 *   1password://<vault>/<item>/<field>
 *                                — 1Password `op` CLI
 *   env:<NAME>                   — process.env.NAME
 *   literal:<value>              — plaintext passthrough
 */
export async function resolveValueRef(ref: string): Promise<string> {
  if (ref.startsWith("literal:")) return ref.slice("literal:".length);
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const v = process.env[name];
    if (v === undefined) throw new Error(`env var "${name}" not set`);
    return v;
  }
  if (ref.startsWith("keychain:")) return resolveKeychain(ref.slice("keychain:".length));
  if (ref.startsWith("1password://")) return resolve1Password(ref.slice("1password://".length));
  if (ref.startsWith("vault://")) throw new Error("vault:// resolution is Phase 4 (requires daemon auth token + service binding)");
  throw new Error(`unsupported valueRef scheme: ${ref.slice(0, 20)}...`);
}

async function resolveKeychain(rest: string): Promise<string> {
  // format: <service>/<account>[.<jsonKey>]
  const slashIdx = rest.indexOf("/");
  if (slashIdx < 0) throw new Error(`keychain: expected service/account, got "${rest}"`);
  const service = rest.slice(0, slashIdx);
  const remainder = rest.slice(slashIdx + 1);
  const dotIdx = remainder.indexOf(".");
  const account = dotIdx >= 0 ? remainder.slice(0, dotIdx) : remainder;
  const jsonKey = dotIdx >= 0 ? remainder.slice(dotIdx + 1) : null;

  if (!/^[a-z0-9.\-]+$/i.test(service)) throw new Error(`invalid keychain service "${service}"`);
  if (!/^[a-z0-9.\-_]+$/i.test(account)) throw new Error(`invalid keychain account "${account}"`);

  try {
    const { stdout } = await execFileP("security", [
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]);
    const raw = stdout.trim();
    if (!jsonKey) return raw;
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== "object" || obj === null) throw new Error("not JSON object");
      const v = obj[jsonKey];
      if (v === undefined) throw new Error(`JSON key "${jsonKey}" missing`);
      return String(v);
    } catch (e: any) {
      throw new Error(`keychain ${service}/${account} is not JSON or missing key "${jsonKey}": ${String(e?.message ?? e)}`);
    }
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (msg.includes("could not be found")) {
      throw new Error(`keychain entry missing: security add-generic-password -s ${service} -a ${account} -w '<value>'`);
    }
    throw new Error(`keychain read failed: ${msg}`);
  }
}

async function resolve1Password(rest: string): Promise<string> {
  // format: <vault>/<item>/<field>
  const parts = rest.split("/");
  if (parts.length !== 3) throw new Error(`1password: expected vault/item/field, got "${rest}"`);
  const [vault, item, field] = parts;
  try {
    const { stdout } = await execFileP("op", [
      "read", `op://${vault}/${item}/${field}`,
    ]);
    return stdout.trim();
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      throw new Error(`1password 'op' CLI not installed or item missing: ${rest}`);
    }
    throw new Error(`1password read failed for ${rest}: ${msg}`);
  }
}

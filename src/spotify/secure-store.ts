import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A small, OS-protected backup of the durable sign-in data (Client ID, port, refresh token, display name).
 *
 * Why: Stream Deck keeps plugin global settings behind a Windows Credential Manager entry, and on some machines it
 * fails to read them back after the app is killed or Windows shuts down ("Failed to parse account settings from
 * credentials"), handing the plugin empty settings. Elgato's own plugins hit the same error. This store lets the
 * plugin restore itself instead of asking the user to reconnect.
 *
 * - Windows: DPAPI (CurrentUser) via PowerShell, saved to %APPDATA%\SimplySpotify\connection.dat. Only the same
 *   Windows user on the same machine can decrypt it. Data is passed over stdin, never on a command line.
 * - macOS: the login Keychain via `security -i` (commands on stdin, so the secret never appears in `ps`).
 * - Anything else: disabled (Stream Deck's own storage only).
 */

export type Durable = {
  clientId?: string;
  port?: number;
  refreshToken?: string;
  userName?: string;
  /** Epoch ms of the write, used to pick the newer copy when both stores have data. */
  savedAt?: number;
};

const SERVICE = "com.mjp.spotifydeck";
const ACCOUNT = "connection";
const TIMEOUT_MS = 15_000;

export function storePath(): string {
  const base = process.env.SIMPLY_SPOTIFY_DATA_DIR ?? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(base, "SimplySpotify", "connection.dat");
}

export const secureStoreSupported = process.platform === "win32" || process.platform === "darwin";

function run(cmd: string, args: string[], input: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    child.stdin.end(input, "utf8");
  });
}

// ---- Windows (DPAPI) ---------------------------------------------------------

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const PS_PROTECT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$t=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($t); " +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$t=[Console]::In.ReadToEnd().Trim(); $p=[Convert]::FromBase64String($t); " +
  "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Console]::Out.Write([Convert]::ToBase64String($b))";

async function winWrite(json: string): Promise<void> {
  const r = await run("powershell.exe", [...PS_ARGS, PS_PROTECT], json);
  if (r.code !== 0 || !r.out.trim()) throw new Error(`DPAPI protect failed (${r.code}): ${r.err.trim().slice(0, 200)}`);
  const file = storePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, r.out.trim(), "utf8");
  await rename(tmp, file);
}

async function winRead(): Promise<string | null> {
  let blob: string;
  try {
    blob = await readFile(storePath(), "utf8");
  } catch {
    return null;
  }
  const r = await run("powershell.exe", [...PS_ARGS, PS_UNPROTECT], blob);
  if (r.code !== 0) throw new Error(`DPAPI unprotect failed (${r.code}): ${r.err.trim().slice(0, 200)}`);
  return Buffer.from(r.out.trim(), "base64").toString("utf8");
}

async function winClear(): Promise<void> {
  await rm(storePath(), { force: true });
}

// ---- macOS (Keychain) --------------------------------------------------------

async function macWrite(json: string): Promise<void> {
  const b64 = Buffer.from(json, "utf8").toString("base64"); // base64 never needs quoting
  const r = await run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${b64}\n`);
  if (r.code !== 0) throw new Error(`Keychain write failed (${r.code}): ${r.err.trim().slice(0, 200)}`);
}

async function macRead(): Promise<string | null> {
  const r = await run("security", ["-i"], `find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w\n`);
  const line = r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z0-9+/=]{8,}$/.test(l));
  if (!line) return null;
  return Buffer.from(line, "base64").toString("utf8");
}

async function macClear(): Promise<void> {
  await run("security", ["-i"], `delete-generic-password -s ${SERVICE} -a ${ACCOUNT}\n`);
}

// ---- Public API --------------------------------------------------------------

export async function readDurable(): Promise<Durable | null> {
  if (!secureStoreSupported) return null;
  const text = process.platform === "win32" ? await winRead() : await macRead();
  if (!text) return null;
  const parsed = JSON.parse(text) as Durable;
  return parsed && typeof parsed === "object" ? parsed : null;
}

export async function writeDurable(d: Durable): Promise<void> {
  if (!secureStoreSupported) return;
  const clean: Durable = {};
  if (d.clientId) clean.clientId = d.clientId;
  if (d.port) clean.port = d.port;
  if (d.refreshToken) clean.refreshToken = d.refreshToken;
  if (d.userName) clean.userName = d.userName;
  clean.savedAt = d.savedAt ?? Date.now();
  const json = JSON.stringify(clean);
  if (process.platform === "win32") await winWrite(json);
  else await macWrite(json);
}

export async function clearDurable(): Promise<void> {
  if (!secureStoreSupported) return;
  if (process.platform === "win32") await winClear();
  else await macClear();
}

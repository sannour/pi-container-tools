/**
 * Container Tools Extension
 *
 * Downloads and installs CLI tools into a non-root location (/workspace/.pi/tools/)
 * so they don't pollute the container rootfs. Provides:
 *
 * 1. `install_tool` custom tool — download a binary from a URL
 * 2. Package manager interceptor — redirects apt/pip/npm/apk installs
 * 3. PATH injection — makes installed tools available to all bash commands
 *
 * Directory layout under /workspace/.pi/tools/:
 *   bin/          directly downloaded binaries
 *   apt/          apt-installed packages
 *   pip-packages/ pip-installed packages
 *   npm/          globally installed npm packages
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOOLS_ROOT = "/workspace/.pi/tools";
const TOOLS_BIN = resolve(TOOLS_ROOT, "bin");
const APT_ROOT = resolve(TOOLS_ROOT, "apt");
const PIP_TARGET = resolve(TOOLS_ROOT, "pip-packages");
const NPM_PREFIX = resolve(TOOLS_ROOT, "npm");

/** Directories to prepend to PATH in every bash command. */
const PATH_DIRS = [
  TOOLS_BIN,
  resolve(APT_ROOT, "usr/bin"),
  resolve(APT_ROOT, "usr/local/bin"),
  resolve(APT_ROOT, "bin"),
  resolve(TOOLS_ROOT, "npm/bin"),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs() {
  for (const d of [TOOLS_BIN, APT_ROOT, PIP_TARGET, NPM_PREFIX]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** Build the PATH export snippet that gets prepended to every bash command. */
function pathExport(): string {
  const existing = PATH_DIRS.filter((d) => existsSync(d));
  if (existing.length === 0) return "";
  // Also add pip bin dirs — the user may install scripts via pip
  const pipBin = resolve(PIP_TARGET, "bin");
  if (existsSync(pipBin)) existing.push(pipBin);
  // npm bin
  const npmBin = resolve(NPM_PREFIX, "bin");
  if (existsSync(npmBin)) existing.push(npmBin);

  return `export PATH="${existing.join(":")}:$PATH"`;
}

// ---------------------------------------------------------------------------
// Package manager redirectors
// ---------------------------------------------------------------------------

interface RedirectRule {
  /** Regex to match against the raw command. */
  pattern: RegExp;
  /** Rewrite function — receives match groups, returns the rewritten command (or null to skip). */
  rewrite: (match: RegExpMatchArray) => string | null;
}

const REDIRECTS: RedirectRule[] = [
  // --- apt / apt-get ---
  {
    pattern: /^(?:sudo\s+)?(?:apt-get|apt)\s+install\s+(.+)/,
    rewrite: (m) => {
      const pkgs = m[1]!;
      // apt with alternate root. Need to create dpkg dirs inside the root first.
      return [
        `mkdir -p ${APT_ROOT}/var/lib/dpkg ${APT_ROOT}/var/cache/apt/archives/partial ${APT_ROOT}/etc/apt`,
        `touch ${APT_ROOT}/var/lib/dpkg/status`,
        `apt-get update -o Dir=${APT_ROOT} -o Dir::State::status=${APT_ROOT}/var/lib/dpkg/status`,
        `apt-get install -y --no-install-recommends -o Dir=${APT_ROOT} -o Dir::State::status=${APT_ROOT}/var/lib/dpkg/status ${pkgs}`,
      ].join(" && ");
    },
  },
  // apt update (standalone)
  {
    pattern: /^(?:sudo\s+)?(?:apt-get|apt)\s+update\s*$/,
    rewrite: () =>
      `apt-get update -o Dir=${APT_ROOT} -o Dir::State::status=${APT_ROOT}/var/lib/dpkg/status`,
  },
  // --- apk (Alpine) ---
  {
    pattern: /^(?:sudo\s+)?apk\s+add\s+(.+)/,
    rewrite: (m) => {
      const pkgs = m[1]!;
      return `apk add --root ${APT_ROOT} ${pkgs}`;
    },
  },
  // --- pip / pip3 ---
  {
    pattern: /^(?:sudo\s+)?(?:python(?:3)?\s+-m\s+)?pip(?:3)?\s+install\s+(.+)/,
    rewrite: (m) => {
      // Strip --user if present, add --target
      let args = m[1]!;
      args = args.replace(/--user\b\s*/g, "");
      if (!args.includes("--target")) {
        args += ` --target ${PIP_TARGET}`;
      }
      return `pip install ${args}`;
    },
  },
  // --- npm global ---
  {
    pattern: /^(?:sudo\s+)?npm\s+(?:i|install)\s+-g\s+(.+)/,
    rewrite: (m) => {
      const args = m[1]!;
      return `npm install --prefix ${NPM_PREFIX} ${args}`;
    },
  },
  // npm global uninstall
  {
    pattern: /^(?:sudo\s+)?npm\s+(?:un|uninstall)\s+-g\s+(.+)/,
    rewrite: (m) => {
      const args = m[1]!;
      return `npm uninstall --prefix ${NPM_PREFIX} ${args}`;
    },
  },
  // --- dnf (Fedora/RHEL) ---
  {
    pattern: /^(?:sudo\s+)?dnf\s+install\s+(.+)/,
    rewrite: (m) => {
      const pkgs = m[1]!;
      return `dnf install --installroot=${APT_ROOT} --releasever=/ --setopt=tsflags=nodocs -y ${pkgs}`;
    },
  },
  // --- yum (older RHEL) ---
  {
    pattern: /^(?:sudo\s+)?yum\s+install\s+(.+)/,
    rewrite: (m) => {
      const pkgs = m[1]!;
      return `yum install --installroot=${APT_ROOT} --releasever=/ --setopt=tsflags=nodocs -y ${pkgs}`;
    },
  },
  // --- pacman (Arch) ---
  {
    pattern: /^(?:sudo\s+)?pacman\s+-S\s+(.+)/,
    rewrite: (m) => {
      const pkgs = m[1]!;
      return `pacman -S --root ${APT_ROOT} --noconfirm ${pkgs}`;
    },
  },
];

function tryRedirect(command: string): string | null {
  const trimmed = command.trim();
  for (const rule of REDIRECTS) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      const rewritten = rule.rewrite(match);
      if (rewritten) return rewritten;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Standard input download for install_tool (hash verification)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

async function downloadToPipe(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-fsSL", "--connect-timeout", "30", url], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- Session startup ----
  pi.on("session_start", async (_event, ctx) => {
    ensureDirs();
    ctx.ui.setStatus("container-tools", `Tools: ${TOOLS_ROOT}`);
  });

  // ---- Inject PATH + intercept package manager installs (single handler) ----
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    let command = event.input.command as string;

    // 1. Try package manager redirect first (before PATH is prepended)
    const redirected = tryRedirect(command);
    if (redirected && redirected !== command) {
      ensureDirs();
      command = redirected;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Redirected install to ${TOOLS_ROOT}`,
          "info",
        );
      }
    }

    // 2. Prepend tools PATH to every bash command
    const exportLine = pathExport();
    event.input.command = exportLine
      ? `${exportLine}\n${command}`
      : command;
  });

  // ---- Register install_tool ----
  pi.registerTool({
    name: "install_tool",
    label: "Install Tool",
    description:
      "Download a CLI tool binary from a URL and install it into /workspace/.pi/tools/bin/. " +
      "Use this when the needed tool is not already installed in the container. " +
      "The tool becomes immediately available in subsequent bash commands.",
    promptSnippet:
      "Download and install a CLI tool binary from a URL into /workspace/.pi/tools/bin/",
    promptGuidelines: [
      "Use install_tool when a CLI tool or binary is not found in the container. Download it to /workspace/.pi/tools/bin/ so it persists and is on PATH.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description:
          "URL to download the binary from (must be a direct binary link, not an HTML page)",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Name for the installed binary (basename extracted from URL if omitted)",
        }),
      ),
      checksum: Type.Optional(
        Type.String({
          description:
            "Expected SHA256 hex digest of the downloaded file for verification",
        }),
      ),
      extract: Type.Optional(
        Type.Boolean({
          description:
            "If true, treat the URL as a tar.gz archive and extract the binary named `name` from it",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      ensureDirs();

      let fileName: string;
      if (params.name) {
        fileName = params.name;
      } else {
        // Extract basename from URL
        const urlPath = new URL(params.url).pathname;
        fileName = urlPath.split("/").pop() || "downloaded-tool";
        // Strip query params if any leaked
        fileName = fileName.split("?")[0]!;
      }

      const destPath = resolve(TOOLS_BIN, fileName);

      if (params.extract) {
        // Download archive, extract the named binary
        const { execSync } = await import("node:child_process");
        const tmpArchive = resolve(TOOLS_BIN, `.tmp-${Date.now()}.tar.gz`);
        const tmpDir = resolve(TOOLS_BIN, `.tmp-extract-${Date.now()}`);

        try {
          mkdirSync(tmpDir, { recursive: true });

          // Download archive
          const dlResult = await downloadToPipe(params.url, signal);
          if (dlResult.exitCode !== 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Download failed (exit ${dlResult.exitCode}):\n${dlResult.stderr}`,
                },
              ],
              details: {},
              isError: true,
            };
          }

          // Write archive to temp file
          const { writeFileSync, unlinkSync, rmdirSync } = await import("node:fs");
          writeFileSync(tmpArchive, dlResult.stdout);

          // Extract
          execSync(`tar -xzf ${tmpArchive} -C ${tmpDir}`, {
            stdio: "pipe",
            signal,
          });

          // Find the named binary
          const { readdirSync, statSync, renameSync } = await import("node:fs");
          const { join } = await import("node:path");

          function findFile(dir: string, name: string): string | null {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = join(dir, entry.name);
              if (entry.isFile() && entry.name === name) return full;
              if (entry.isDirectory()) {
                const found = findFile(full, name);
                if (found) return found;
              }
            }
            return null;
          }

          const found = findFile(tmpDir, fileName);

          if (!found) {
            // List what was extracted
            const list = execSync(`find ${tmpDir} -type f`, {
              encoding: "utf-8",
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Binary "${fileName}" not found in archive. Extracted files:\n${list}`,
                },
              ],
              details: {},
              isError: true,
            };
          }

          // Checksum verification
          if (params.checksum) {
            const { readFileSync } = await import("node:fs");
            const data = readFileSync(found);
            const hash = createHash("sha256").update(data).digest("hex");
            if (hash !== params.checksum.toLowerCase()) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Checksum mismatch!\nExpected: ${params.checksum}\nGot: ${hash}`,
                  },
                ],
                details: {},
                isError: true,
              };
            }
          }

          // Move to final location
          renameSync(found, destPath);
          execSync(`chmod +x ${destPath}`, { stdio: "ignore" });

          unlinkSync(tmpArchive);
          rmdirSync(tmpDir);
        } catch (err) {
          // Cleanup on error
          try {
            const { rmSync } = await import("node:fs");
            rmSync(tmpArchive, { force: true });
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          throw err;
        }
      } else {
        // Direct binary download
        const result = await downloadToPipe(params.url, signal);

        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text",
                text: `Download failed (exit ${result.exitCode}):\n${result.stderr}`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        if (params.checksum) {
          const hash = createHash("sha256")
            .update(result.stdout)
            .digest("hex");
          if (hash !== params.checksum.toLowerCase()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Checksum mismatch!\nExpected: ${params.checksum}\nGot: ${hash}`,
                },
              ],
              details: {},
              isError: true,
            };
          }
        }

        const { writeFileSync, chmodSync } = await import("node:fs");
        writeFileSync(destPath, result.stdout);
        chmodSync(destPath, 0o755);
      }

      // Verify it's now on PATH
      const { execSync } = await import("node:child_process");
      let versionInfo = "";
      try {
        const pathEnv = PATH_DIRS.filter((d) => existsSync(d)).join(":");
        versionInfo = execSync(
          `PATH="${pathEnv}:$PATH" ${fileName} --version 2>&1 || ${fileName} version 2>&1 || true`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
      } catch {
        versionInfo = "(version check skipped)";
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Installed \`${fileName}\` to \`${destPath}\`\n\n` +
              `It is now available on PATH for subsequent bash commands.\n\n` +
              `Version info:\n\`\`\`\n${versionInfo}\n\`\`\``,
          },
        ],
        details: {
          path: destPath,
          name: fileName,
          version: versionInfo,
        },
      };
    },
  });

  // ---- Register a status command ----
  pi.registerCommand("tools", {
    description: "Show installed container tools",
    handler: async (_args, ctx) => {
      const { readdirSync, statSync } = await import("node:fs");

      const bins: string[] = [];
      if (existsSync(TOOLS_BIN)) {
        for (const f of readdirSync(TOOLS_BIN)) {
          if (!f.startsWith(".")) {
            const s = statSync(resolve(TOOLS_BIN, f));
            bins.push(`${f} (${(s.size / 1024).toFixed(1)} KB)`);
          }
        }
      }

      const lines = [`Tools root: ${TOOLS_ROOT}`, ""];
      lines.push(`PATH directories:`);
      for (const d of PATH_DIRS) {
        lines.push(`  ${existsSync(d) ? "✓" : "✗"} ${d}`);
      }

      lines.push("");
      lines.push(`Installed binaries (${bins.length}):`);
      if (bins.length === 0) {
        lines.push("  (none)");
      } else {
        for (const b of bins) lines.push(`  • ${b}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

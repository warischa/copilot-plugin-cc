// Unit tests for the cross-platform auth detection (DESIGN.md §5 item 4).
//
// We can't actually run a Linux libsecret query or Windows cmdkey from a
// macOS dev machine, so each test injects a fake `runCommand`,
// `binaryAvailable`, `homedir`, and `platform` via the options object on
// `getCopilotAuthStatus` to exercise each code path deterministically.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { getCopilotAuthStatus, parseSecretToolOutput, parseCmdKeyOutput } =
  await import("../plugins/copilot/scripts/lib/copilot.mjs");

// `getCopilotAvailability` runs the real `copilot --version` before we
// reach the detection chain, so tests have to assume copilot is on PATH.
// Skip the whole suite if it isn't — we don't want CI failures from a
// missing binary while we're testing auth-detection logic.
import { execSync } from "node:child_process";
let copilotOnPath = true;
try {
  execSync("copilot --version", { stdio: "ignore" });
} catch {
  copilotOnPath = false;
}

function fakeOk(stdout = "ok") {
  return { status: 0, stdout, stderr: "", error: null, signal: null };
}
function fakeFail(stderr = "not found") {
  return { status: 1, stdout: "", stderr, error: null, signal: null };
}

describe("parseSecretToolOutput", () => {
  it("returns true when stdout has content", () => {
    assert.equal(parseSecretToolOutput("[/secret/foo]\nattribute.service = copilot-cli"), true);
  });
  it("returns false for empty / whitespace stdout", () => {
    assert.equal(parseSecretToolOutput(""), false);
    assert.equal(parseSecretToolOutput("   \n  "), false);
    assert.equal(parseSecretToolOutput(null), false);
    assert.equal(parseSecretToolOutput(undefined), false);
  });
});

describe("parseCmdKeyOutput", () => {
  it("finds a target line referencing copilot", () => {
    const sample = [
      "Currently stored credentials:",
      "    Target: LegacyGeneric:target=copilot-cli",
      "    Type: Generic",
      "    User: alice"
    ].join("\n");
    const target = parseCmdKeyOutput(sample);
    assert.match(target, /copilot/);
  });
  it("returns null when no copilot credentials are present", () => {
    const sample = [
      "Currently stored credentials:",
      "    Target: LegacyGeneric:target=git:https://github.com",
      "    Type: Generic"
    ].join("\n");
    assert.equal(parseCmdKeyOutput(sample), null);
  });
  it("handles empty input", () => {
    assert.equal(parseCmdKeyOutput(""), null);
    assert.equal(parseCmdKeyOutput(null), null);
  });
});

describe("getCopilotAuthStatus auth-source chain", () => {
  if (!copilotOnPath) {
    it.skip("requires the `copilot` binary on PATH", () => {});
    return;
  }

  it("Linux: detects libsecret-stored creds when secret-tool finds an entry", () => {
    const status = getCopilotAuthStatus(process.cwd(), {
      env: {},
      platform: "linux",
      homedir: "/home/nobody",
      existsSync: () => false,
      binaryAvailable: () => ({ available: true, detail: "secret-tool 0.20" }),
      runCommand: (cmd, args) => {
        if (cmd === "secret-tool" && args[0] === "search") {
          // First service name returns a hit.
          return fakeOk("[/secret/copilot]\nservice = copilot-cli\n");
        }
        return fakeFail();
      }
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.source, "libsecret");
    assert.match(status.detail, /libsecret/);
  });

  it("Linux: skips libsecret check when secret-tool is missing", () => {
    const status = getCopilotAuthStatus(process.cwd(), {
      env: {},
      platform: "linux",
      homedir: "/home/nobody",
      existsSync: () => false,
      binaryAvailable: () => ({ available: false, detail: "not found" }),
      runCommand: () => {
        throw new Error("runCommand should not be called when secret-tool is missing");
      }
    });
    assert.equal(status.loggedIn, false);
    assert.equal(status.source, "unknown");
  });

  it("Windows: detects creds via cmdkey output containing target=copilot-cli", () => {
    const status = getCopilotAuthStatus(process.cwd(), {
      env: {},
      platform: "win32",
      homedir: "C:\\Users\\nobody",
      existsSync: () => false,
      binaryAvailable: () => ({ available: true, detail: "cmdkey" }),
      runCommand: (cmd) => {
        if (cmd === "cmdkey") {
          return fakeOk(
            "Currently stored credentials:\n    Target: LegacyGeneric:target=copilot-cli\n    Type: Generic\n"
          );
        }
        return fakeFail();
      }
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.source, "wincred");
    assert.match(status.detail, /Windows Credential Manager/);
  });

  it("Windows: falls through when cmdkey output has no copilot entry", () => {
    const status = getCopilotAuthStatus(process.cwd(), {
      env: {},
      platform: "win32",
      homedir: "C:\\Users\\nobody",
      existsSync: () => false,
      binaryAvailable: () => ({ available: true, detail: "cmdkey" }),
      runCommand: (cmd) => {
        if (cmd === "cmdkey") {
          return fakeOk(
            "Currently stored credentials:\n    Target: LegacyGeneric:target=git:https://github.com\n"
          );
        }
        return fakeFail();
      }
    });
    assert.equal(status.loggedIn, false);
  });

  it("env auth still wins over platform-specific probes", () => {
    const status = getCopilotAuthStatus(process.cwd(), {
      env: { GITHUB_TOKEN: "ghp_fake" },
      platform: "linux",
      binaryAvailable: () => {
        throw new Error("should short-circuit before probing binaries");
      },
      runCommand: () => {
        throw new Error("should short-circuit before running commands");
      }
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.source, "env");
  });

  it("plaintext file is the last-resort source on any platform", () => {
    const fakePath = "/tmp/fake-home/.copilot/auth.json";
    const status = getCopilotAuthStatus(process.cwd(), {
      env: {},
      platform: "linux",
      homedir: "/tmp/fake-home",
      binaryAvailable: () => ({ available: false, detail: "not found" }),
      existsSync: (p) => p === fakePath,
      statSync: () => ({ size: 256 }),
      runCommand: () => fakeFail()
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.source, "plaintext");
    assert.match(status.detail, /auth\.json/);
  });
});

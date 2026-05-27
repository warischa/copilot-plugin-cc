import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isProbablyText,
  writeJsonFile,
  readJsonFile,
  safeReadFile,
  ensureAbsolutePath,
} from "../plugins/copilot/scripts/lib/fs.mjs";

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fs-test-"));
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("isProbablyText", () => {
  it("returns true for a UTF-8 text buffer", () => {
    const buf = Buffer.from("hello world\nfoo bar\n", "utf8");
    assert.equal(isProbablyText(buf), true);
  });

  it("returns false for a buffer containing a null byte", () => {
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x00, 0x6f]);
    assert.equal(isProbablyText(buf), false);
  });

  it("returns true for an empty buffer", () => {
    assert.equal(isProbablyText(Buffer.alloc(0)), true);
  });

  it("returns false when null byte is beyond 4096-byte sample boundary", () => {
    // Only the first 4096 bytes are sampled; a null byte at position 5000
    // (beyond the sample) should be invisible to isProbablyText.
    const big = Buffer.alloc(5100, 0x41); // all 'A'
    big[5000] = 0; // beyond the 4096-byte sample
    assert.equal(isProbablyText(big), true);
  });
});

describe("writeJsonFile / readJsonFile round-trip", () => {
  it("writes and reads back a plain object", () => {
    const filePath = path.join(tempDir, "round-trip.json");
    const value = { foo: "bar", num: 42, flag: true };
    writeJsonFile(filePath, value);
    const result = readJsonFile(filePath);
    assert.deepEqual(result, value);
  });

  it("writes and reads back an array", () => {
    const filePath = path.join(tempDir, "array.json");
    const value = [1, "two", { three: 3 }];
    writeJsonFile(filePath, value);
    const result = readJsonFile(filePath);
    assert.deepEqual(result, value);
  });

  it("written file ends with a newline", () => {
    const filePath = path.join(tempDir, "newline.json");
    writeJsonFile(filePath, { x: 1 });
    const raw = fs.readFileSync(filePath, "utf8");
    assert.equal(raw[raw.length - 1], "\n");
  });
});

describe("safeReadFile", () => {
  it("returns empty string for a missing path", () => {
    const missing = path.join(tempDir, "does-not-exist.txt");
    assert.equal(safeReadFile(missing), "");
  });

  it("returns file contents when the file exists", () => {
    const filePath = path.join(tempDir, "exists.txt");
    fs.writeFileSync(filePath, "hello", "utf8");
    assert.equal(safeReadFile(filePath), "hello");
  });
});

describe("ensureAbsolutePath", () => {
  it("returns an absolute path unchanged", () => {
    const abs = "/some/absolute/path";
    assert.equal(ensureAbsolutePath("/cwd", abs), abs);
  });

  it("resolves a relative path against cwd", () => {
    const cwd = "/my/project";
    const rel = "src/index.js";
    assert.equal(ensureAbsolutePath(cwd, rel), path.join(cwd, rel));
  });

  it("resolves . relative to cwd", () => {
    assert.equal(ensureAbsolutePath("/a/b", "."), "/a/b");
  });
});

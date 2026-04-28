import { $ } from "bun";

import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Progress } from "./progress";
import { cwd } from "node:process";

const ARTIFACT_API =
  process.env.ARTIFACT_API_URL ??
  "https://api.github.com/repos/Homebrew/formulae.brew.sh/actions/artifacts?name=github-pages";
const RETRIES = 5;
const BASE_DELAY_MS = 2000;

type HeadersMap = Record<string, string>;

const CACHE_DIR =
  process.env.CACHE_DIR ??
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "formulae-mirror-artifacts",
  );

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? join(cwd(), "dist");
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const R2_BUCKET = process.env.R2_BUCKET ?? "formulae-mirror-large";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRetriableStatus = (s: number) => s === 429 || s >= 500;
const retryDelay = (attempt: number) =>
  BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;

function setOutput(name: string, value: string) {
  const ghEnv = process.env.GITHUB_OUTPUT;
  if (ghEnv) {
    appendFileSync(ghEnv, `${name}=${value}\n`);
  }
  console.log(`  ::set-output name=${name}::${value}`);
}

async function fetchJson(url: string, headers: HeadersMap): Promise<any> {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", headers });
    } catch (e: any) {
      if (attempt >= RETRIES) {
        throw new Error(`fetch ${url}: ${e?.message ?? "network error"}`);
      }
      const delay = retryDelay(attempt);
      console.log(
        `  retry ${attempt}/${RETRIES} network error for ${url} (wait ${Math.round(delay)}ms)`,
      );
      await sleep(delay);
      continue;
    }
    if (res.ok) return await res.json();
    if (isRetriableStatus(res.status)) {
      const delay = retryDelay(attempt);
      console.log(
        `  retry ${attempt}/${RETRIES} ${res.status} for ${url} (wait ${Math.round(delay)}ms)`,
      );
      await sleep(delay);
      continue;
    }
    throw new Error(`fetch ${url}: ${res.status}`);
  }
  throw new Error(`fetch ${url}: failed after ${RETRIES} retries`);
}

async function downloadToFile(
  url: string,
  dest: string,
  expectedBytes: number,
  headers?: HeadersMap,
): Promise<void> {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const existingBytes = existsSync(dest) ? Bun.file(dest).size : 0;
      if (existingBytes === expectedBytes) return;

      if (existingBytes > expectedBytes) unlinkSync(dest);
      const resumeBytes = existingBytes > expectedBytes ? 0 : existingBytes;

      const requestHeaders = { ...(headers ?? {}) };
      if (resumeBytes > 0) {
        requestHeaders.Range = `bytes=${resumeBytes}-`;
      }

      const res = await fetch(url, {
        redirect: "follow",
        headers: requestHeaders,
      });
      if (res.status === 416 && resumeBytes === expectedBytes) return;
      if (!res.ok) {
        if (isRetriableStatus(res.status)) {
          const delay = retryDelay(attempt);
          console.log(
            `  download retry ${attempt}/${RETRIES} ${res.status} (wait ${Math.round(delay)}ms)`,
          );
          await sleep(delay);
          continue;
        }
        throw new Error(`download ${url}: ${res.status}`);
      }

      const appending = resumeBytes > 0 && res.status === 206;
      if (resumeBytes > 0 && !appending) unlinkSync(dest);

      const startBytes = appending ? resumeBytes : 0;
      const total =
        expectedBytes ||
        startBytes + Number(res.headers.get("content-length") ?? 0);
      const progress = new Progress("download", total, "bytes");
      progress.start(startBytes);
      if (startBytes > 0) progress.update(startBytes);

      if (!res.body) throw new Error(`download ${url}: empty response body`);
      const writer = createWriteStream(dest, {
        flags: appending ? "a" : "w",
        highWaterMark: 1024 * 1024,
      });
      const stream = Readable.fromWeb(res.body as ReadableStream);
      const timer = setInterval(() => {
        progress.update(Bun.file(dest).size);
      }, 200);
      try {
        await pipeline(stream, writer);
      } finally {
        clearInterval(timer);
      }

      const downloaded = Bun.file(dest).size;
      progress.update(downloaded);
      if (downloaded !== expectedBytes) {
        throw new Error(
          `Download incomplete: expected ${expectedBytes} bytes, got ${downloaded}`,
        );
      }
      return;
    } catch (e: any) {
      if (attempt >= RETRIES) throw e;
      const delay = retryDelay(attempt);
      console.log(
        `  download retry ${attempt}/${RETRIES} ${
          e?.message ?? "network error"
        } (wait ${Math.round(delay)}ms)`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`download ${url}: failed after ${RETRIES} retries`);
}

function cleanStaleCache(artifactId: number) {
  try {
    for (const entry of readdirSync(CACHE_DIR)) {
      if (!entry.startsWith("artifact-")) continue;
      const id = parseInt(entry.slice("artifact-".length), 10);
      if (isNaN(id) || id === artifactId) continue;
      const fullPath = join(CACHE_DIR, entry);
      rmSync(fullPath, { recursive: true, force: true });
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

async function extractPages(outputDir: string): Promise<{
  filePaths: Set<string>;
  largeFiles: Map<string, string>;
  artifactId: number;
}> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const ghHeaders: HeadersMap = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
    "User-Agent": "formulae-mirror",
  };

  console.log("[1/3] Fetching artifact list from GitHub...");
  const data = await fetchJson(ARTIFACT_API, ghHeaders);

  const latest = data.artifacts.find(
    (a: any) => a.workflow_run?.head_branch === "main" && !a.expired,
  );
  if (!latest)
    throw new Error("No latest github-pages artifact found on main branch");

  const artifactId = latest.id;
  const sizeMB = (latest.size_in_bytes / 1024 / 1024).toFixed(2);
  const cachedZip = join(CACHE_DIR, `artifact-${artifactId}.zip`);

  mkdirSync(CACHE_DIR, { recursive: true });
  cleanStaleCache(artifactId);

  if (existsSync(cachedZip)) {
    console.log(`  using cached artifact #${artifactId} (${sizeMB} MB)`);
  } else {
    console.log(`  downloading artifact #${artifactId} (${sizeMB} MB)...`);
    const tmpZip = cachedZip + ".tmp";
    await downloadToFile(
      latest.archive_download_url,
      tmpZip,
      latest.size_in_bytes,
      ghHeaders,
    );
    const actual = Bun.file(tmpZip).size;
    if (actual !== latest.size_in_bytes) {
      unlinkSync(tmpZip);
      throw new Error(
        `Download incomplete: expected ${latest.size_in_bytes} bytes, got ${actual}`,
      );
    }
    renameSync(tmpZip, cachedZip);
    console.log("  cached artifact for future runs");
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "formulae-mirror-"));
  try {
    const unzipDir = join(tmpDir, "unzip");
    mkdirSync(unzipDir, { recursive: true });

    console.log("  extracting zip...");
    await $`unzip -q ${cachedZip} -d ${unzipDir}`;

    const artifactTar = join(unzipDir, "artifact.tar");
    if (!(await Bun.file(artifactTar).exists()))
      throw new Error("artifact.tar not found inside zip");

    console.log("  reading tar...");
    const archive = new Bun.Archive(await Bun.file(artifactTar).bytes());
    const entries = await archive.files();

    const filePaths = new Set<string>();
    const largeFiles = new Map<string, string>();
    const parseProgress = new Progress("extracting", entries.size, "count");
    let count = 0;
    for (const [path, file] of entries) {
      const normalized = path.replace(/^\.\/?/, "");
      if (!normalized) {
        parseProgress.update(++count);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_ASSET_BYTES) {
        const r2Staging = join(CACHE_DIR, "r2-staging");
        const r2Path = join(r2Staging, normalized);
        mkdirSync(join(r2Path, ".."), { recursive: true });
        writeFileSync(r2Path, bytes);
        largeFiles.set(normalized, r2Path);
        parseProgress.update(++count);
        continue;
      }
      const outPath = join(outputDir, normalized);
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, bytes);
      filePaths.add(normalized);
      parseProgress.update(++count);
    }

    console.log(
      `  extracted ${filePaths.size} files to ${outputDir}, ${largeFiles.size} large files for R2`,
    );
    return { filePaths, largeFiles, artifactId };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function uploadToR2(
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      console.log(`  uploading ${bucket}/${key}`)
      await $`wrangler r2 object put ${bucket}/${key} --file ${localPath} --remote`.quiet();
      return;
    } catch (e: any) {
      if (attempt >= RETRIES) throw e;
      const delay = retryDelay(attempt);
      console.log(
        `  R2 retry ${attempt}/${RETRIES} for ${key} (wait ${Math.round(delay)}ms)`,
      );
      await sleep(delay);
    }
  }
}

async function main() {
  console.log("Starting formulae.brew.sh mirror sync...");

  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const { filePaths, largeFiles, artifactId } = await extractPages(OUTPUT_DIR);

  if (largeFiles.size > 0) {
    console.log(`[2/3] Uploading ${largeFiles.size} large files to R2...`);
    for (const [key, localPath] of largeFiles) {
      await uploadToR2(R2_BUCKET, key, localPath);
    }
    console.log("  R2 upload complete");
    rmSync(join(CACHE_DIR, "r2-staging"), { recursive: true, force: true });
  }

  setOutput("artifact_id", String(artifactId));
  setOutput("file_count", String(filePaths.size + largeFiles.size));
  setOutput("large_file_count", String(largeFiles.size));

  console.log(
    `Done! ${filePaths.size} assets + ${largeFiles.size} R2 files (artifact #${artifactId}).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

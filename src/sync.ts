import { $ } from "bun";

import { createHash } from "node:crypto";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Progress } from "./progress";
import {
    buildUploadItems,
    createS3,
    deleteInParallel,
    HASH_STATE_KEY,
    loadOldHashes,
    saveHashes,
    uploadInParallel,
} from "./s3";

const ARTIFACT_API =
    process.env.ARTIFACT_API_URL ??
    "https://api.github.com/repos/Homebrew/formulae.brew.sh/actions/artifacts?name=github-pages";
const RETRIES = 5;
const BASE_DELAY_MS = 2000;
const PRIORITY_FILES = ["api/formula.json", "api/cask.json"];

type HeadersMap = Record<string, string>;

const CACHE_DIR =
    process.env.CACHE_DIR ??
    join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "homebrew-api-artifacts",
    );

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRetriableStatus = (s: number) => s === 429 || s >= 500;
const retryDelay = (attempt: number) =>
    BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
const sha256 = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex");

function assertRequiredFiles(
    files: ReadonlyMap<string, Uint8Array>,
    requiredFiles: readonly string[] = PRIORITY_FILES,
): void {
    for (const required of requiredFiles) {
        if (!files.has(required)) {
            throw new Error(`Required file ${required} missing from artifact`);
        }
    }
}

async function fetchJson(url: string, headers: HeadersMap): Promise<any> {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        let res: Response;
        try {
            res = await fetch(url, { redirect: "follow", headers });
        } catch (e: any) {
            if (attempt >= RETRIES) {
                throw new Error(
                    `fetch ${url}: ${e?.message ?? "network error"}`,
                );
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
            const resumeBytes =
                existingBytes > expectedBytes ? 0 : existingBytes;

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

            if (!res.body)
                throw new Error(`download ${url}: empty response body`);
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
            const stat = statSync(fullPath);
            rmSync(fullPath, { recursive: true, force: true });
        }
    } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
    }
}

async function extractApiFiles(): Promise<Map<string, Uint8Array>> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is required");

    const ghHeaders: HeadersMap = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "homebrew-api-mirror",
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
        console.log(
            `[2/3] Downloading artifact #${artifactId} (${sizeMB} MB)...`,
        );
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

    const tmpDir = mkdtempSync(join(tmpdir(), "homebrew-api-"));
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

        const files = new Map<string, Uint8Array>();
        const parseProgress = new Progress("parsing", entries.size, "count");
        let count = 0;
        for (const [path, file] of entries) {
            const normalized = path.replace(/^\.\/?/, "");
            if (
                normalized.startsWith("api/") &&
                normalized !== "api/index.html"
            )
                files.set(normalized, new Uint8Array(await file.arrayBuffer()));
            parseProgress.update(++count);
        }

        assertRequiredFiles(files);

        console.log(`  found ${files.size} API files in artifact`);
        return files;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function computeDelta(
    newHashes: ReadonlyMap<string, string>,
    oldHashes: ReadonlyMap<string, string>,
): { toUpload: string[]; toDelete: string[] } {
    const toUpload: string[] = [];
    const toDelete: string[] = [];

    for (const [path, hash] of newHashes) {
        if (oldHashes.get(path) !== hash) toUpload.push(path);
    }
    for (const path of oldHashes.keys()) {
        if (!newHashes.has(path) && path !== HASH_STATE_KEY) {
            toDelete.push(path);
        }
    }

    return { toUpload, toDelete };
}

async function main() {
    const s3 = createS3();
    console.log("Starting Homebrew API sync...");

    const files = await extractApiFiles();

    console.log("[2/3] Hashing and comparing...");
    const newHashes = new Map<string, string>();
    const hashProgress = new Progress("hashing", files.size, "count");
    let hashed = 0;
    for (const [path, data] of files) {
        newHashes.set(path, sha256(data));
        hashProgress.update(++hashed);
    }

    const oldHashes = await loadOldHashes(s3);
    const { toUpload, toDelete } = computeDelta(newHashes, oldHashes);

    console.log(`  ${toUpload.length} changed/new files to upload`);
    console.log(`  ${toDelete.length} stale files to delete`);

    if (toUpload.length > 0) {
        console.log("[3/3] Uploading...");

        const prioritySet = new Set<string>(PRIORITY_FILES);
        toUpload.sort((a, b) => {
            const aPri = prioritySet.has(a) ? 0 : 1;
            const bPri = prioritySet.has(b) ? 0 : 1;
            return aPri !== bPri
                ? aPri - bPri
                : files.get(a)!.length - files.get(b)!.length;
        });

        const uploads = buildUploadItems(toUpload, files);

        const t = Date.now();
        await uploadInParallel(s3, uploads);
        console.log(
            `  uploaded ${uploads.length} files in ${((Date.now() - t) / 1000).toFixed(1)}s`,
        );
    } else {
        console.log("[3/3] No files to upload");
    }

    if (toDelete.length > 0) {
        console.log("Deleting stale files...");
        await deleteInParallel(s3, toDelete);
        console.log(`  deleted ${toDelete.length} files`);
    }

    console.log("Saving hash state...");
    await saveHashes(s3, newHashes);

    console.log(
        `Done! ${toUpload.length} uploads, ${toDelete.length} deletes, ${files.size} total files tracked.`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

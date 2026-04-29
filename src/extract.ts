import { $ } from "bun";

import {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRetriableStatus = (s: number) => s === 429 || s >= 500;
const retryDelay = (attempt: number) =>
    BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;

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
            rmSync(fullPath, { recursive: true, force: true });
        }
    } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
    }
}

interface LatestArtifact {
    id: number;
    archiveDownloadUrl: string;
    sizeInBytes: number;
}

async function fetchLatestArtifact(): Promise<LatestArtifact> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is required");

    const ghHeaders: HeadersMap = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "formulae-mirror",
    };

    console.log("Fetching latest artifact from GitHub...");
    const data = await fetchJson(ARTIFACT_API, ghHeaders);

    const latest = data.artifacts.find(
        (a: any) => a.workflow_run?.head_branch === "main" && !a.expired,
    );
    if (!latest)
        throw new Error("No latest github-pages artifact found on main branch");

    return {
        id: latest.id,
        archiveDownloadUrl: latest.archive_download_url,
        sizeInBytes: latest.size_in_bytes,
    };
}

async function extractPages(outputDir: string): Promise<{
    filePaths: Set<string>;
    artifactId: number;
}> {
    const token = process.env.GITHUB_TOKEN;
    if (!token)
        throw new Error(
            "GITHUB_TOKEN is required (set in .env for local dev)",
        );

    const ghHeaders: HeadersMap = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "formulae-mirror",
    };

    const latest = await fetchLatestArtifact();

    const artifactId = latest.id;
    const sizeMB = (latest.sizeInBytes / 1024 / 1024).toFixed(2);
    const cachedZip = join(CACHE_DIR, `artifact-${artifactId}.zip`);

    mkdirSync(CACHE_DIR, { recursive: true });
    cleanStaleCache(artifactId);

    if (existsSync(cachedZip)) {
        console.log(`  using cached artifact #${artifactId} (${sizeMB} MB)`);
    } else {
        console.log(`  downloading artifact #${artifactId} (${sizeMB} MB)...`);
        const tmpZip = cachedZip + ".tmp";

        const nightlyUrl = `https://nightly.link/Homebrew/formulae.brew.sh/actions/artifacts/${artifactId}.zip`;
        try {
            await downloadToFile(nightlyUrl, tmpZip, latest.sizeInBytes);
            console.log("  downloaded via nightly.link");
        } catch (nightlyErr: any) {
            console.log(
                `  nightly.link failed (${nightlyErr?.message ?? "unknown error"}), falling back to GitHub API...`,
            );
            if (existsSync(tmpZip)) unlinkSync(tmpZip);
            await downloadToFile(
                latest.archiveDownloadUrl,
                tmpZip,
                latest.sizeInBytes,
                ghHeaders,
            );
            console.log("  downloaded via GitHub API");
        }

        const actual = Bun.file(tmpZip).size;
        if (actual !== latest.sizeInBytes) {
            unlinkSync(tmpZip);
            throw new Error(
                `Download incomplete: expected ${latest.sizeInBytes} bytes, got ${actual}`,
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
        const parseProgress = new Progress("extracting", entries.size, "count");
        let count = 0;
        for (const [path, file] of entries) {
            const normalized = path.replace(/^\.\/?/, "");
            if (!normalized) {
                parseProgress.update(++count);
                continue;
            }
            const outPath = join(outputDir, normalized);
            mkdirSync(join(outPath, ".."), { recursive: true });
            writeFileSync(outPath, new Uint8Array(await file.arrayBuffer()));
            filePaths.add(normalized);
            parseProgress.update(++count);
        }

        console.log(`  extracted ${filePaths.size} files to ${outputDir}`);
        return { filePaths, artifactId };
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function main() {
    console.log("Starting formulae.brew.sh mirror sync...");

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const { filePaths, artifactId } = await extractPages(OUTPUT_DIR);

    writeFileSync(".latest.artifact", String(artifactId));

    console.log(
        `Done! ${filePaths.size} files extracted (artifact #${artifactId}).`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

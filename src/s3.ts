import { S3Client } from "bun";

const HASH_STATE_KEY = "__hash_state__.json";
const RETRIES = 5;
const BASE_DELAY_MS = 2000;
const CONCURRENCY = 64;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryDelay = (attempt: number) =>
    BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;

type HeadersMap = Record<string, string>;
type UploadItem = { key: string; data: Uint8Array; headers: HeadersMap };

export { CONCURRENCY, HASH_STATE_KEY };
export type { HeadersMap, UploadItem };

export function createS3(): S3Client {
    const endpoint = process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    const bucket = process.env.S3_BUCKET;

    if (!endpoint) throw new Error("S3_ENDPOINT is required");
    if (!accessKeyId) throw new Error("S3_ACCESS_KEY_ID is required");
    if (!secretAccessKey) throw new Error("S3_SECRET_ACCESS_KEY is required");
    if (!bucket) throw new Error("S3_BUCKET is required");

    const url = new URL(endpoint);
    const { protocol, host } = url;
    return new S3Client({
        accessKeyId,
        secretAccessKey,
        bucket,
        endpoint: `${protocol}//${host}`,
        region: process.env.S3_REGION || "auto",
        virtualHostedStyle:
            process.env.S3_FORCE_PATH_STYLE === "true"
                ? false
                : url.hostname !== "s3.amazonaws.com",
    });
}

export async function loadOldHashes(
    s3: S3Client,
): Promise<Map<string, string>> {
    const file = s3.file(HASH_STATE_KEY);
    const exists = await file.exists();
    if (!exists) {
        console.log("  no previous hash state found");
        return new Map();
    }
    try {
        return new Map(Object.entries(JSON.parse(await file.text())));
    } catch (e: any) {
        return new Map();
    }
}

export async function saveHashes(s3: S3Client, hashes: Map<string, string>) {
    const data = JSON.stringify(Object.fromEntries(hashes));
    await s3.write(HASH_STATE_KEY, data, {
        type: "application/json",
    });
    console.log(
        `  saved ${hashes.size} hashes to ${HASH_STATE_KEY} (${(data.length / 1024).toFixed(1)} KiB)`,
    );
}

async function uploadFile(
    s3: S3Client,
    key: string,
    data: Uint8Array,
    headers: HeadersMap,
) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            await s3.write(key, data, headers);
            return;
        } catch (e: any) {
            if (attempt >= RETRIES) throw e;
            const delay = retryDelay(attempt);
            console.log(
                `  upload retry ${attempt}/${RETRIES} for ${key} (wait ${Math.round(delay)}ms)`,
            );
            await sleep(delay);
        }
    }
}

const isJson = (path: string) => path.endsWith(".json");

export function headersForUpload(key: string): HeadersMap {
    return {
        type: isJson(key) ? "application/json" : "application/octet-stream",
    };
}

export function buildUploadItems(
    toUpload: string[],
    files: Map<string, Uint8Array>,
) {
    return toUpload.map((key) => ({
        key,
        data: files.get(key)!,
        headers: headersForUpload(key),
    }));
}

export async function uploadInParallel(s3: S3Client, uploads: UploadItem[]) {
    let done = 0;
    const queue = [...uploads];
    const { Progress } = await import("./progress");
    const progress = new Progress("uploading", uploads.length, "count");

    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (queue.length > 0) {
                const item = queue.shift()!;
                await uploadFile(s3, item.key, item.data, item.headers);
                progress.update(++done);
            }
        }),
    );
}

export async function deleteFile(s3: S3Client, key: string) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            await s3.delete(key);
            return;
        } catch (e: any) {
            if (attempt >= RETRIES) throw e;
            const delay = retryDelay(attempt);
            console.log(
                `  delete retry ${attempt}/${RETRIES} for ${key} (wait ${Math.round(delay)}ms)`,
            );
            await sleep(delay);
        }
    }
}

export async function deleteInParallel(
    s3: S3Client,
    keys: string[],
): Promise<void> {
    const deleteQueue = [...keys];
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (deleteQueue.length > 0) {
                await deleteFile(s3, deleteQueue.shift()!);
            }
        }),
    );
}

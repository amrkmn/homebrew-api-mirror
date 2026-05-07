import { $ } from "bun";

const QUAY_URL = process.env.QUAY_URL ?? "https://quay.io";
const QUAY_TOKEN = process.env.QUAY_TOKEN;
const REPOSITORY = process.env.REPOSITORY ?? "amrkmn/formulae-mirror";
const DEFAULT_EXPIRE = process.env.QUAY_DEFAULT_EXPIRE ?? "14d";
const DRY_RUN = process.env.QUAY_DRY_RUN === "true";

interface ExpirationRule {
    name: string;
    regex: string;
    expire: string;
}

const RULES: ExpirationRule[] = [
    { name: "latest", regex: "^latest$", expire: "0s" },
    { name: "artifact", regex: "^[0-9]+$", expire: DEFAULT_EXPIRE },
];

const SECONDS_PER_UNIT: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
};

function toSeconds(s: string): number {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const unit = s.slice(-1);
    const value = parseInt(s.slice(0, -1), 10);
    return value * (SECONDS_PER_UNIT[unit] ?? 1);
}

function getExpirationDate(seconds: number): string {
    const date = new Date(Date.now() + seconds * 1000);
    return date.toISOString();
}

function matchRule(tag: string): ExpirationRule | null {
    for (const rule of RULES) {
        if (new RegExp(rule.regex).test(tag)) return rule;
    }
    return null;
}

async function request<T>(path: string, method: string, data?: any): Promise<T> {
    if (!QUAY_TOKEN) throw new Error("QUAY_TOKEN is required");

    const url = `${QUAY_URL}${path}`;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${QUAY_TOKEN}`,
        Accept: "application/json",
    };

    if (data) {
        headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API ${method} ${path}: ${res.status} ${body}`);
    }

    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
}

async function getTags(repo: string): Promise<Record<string, { expiration?: string }>> {
    const path = `/api/v1/repository/${repo}?includeTags=true`;
    const response = await request<{ tags: Record<string, { expiration?: string }> }>(path, "GET");
    return response.tags;
}

async function putExpiration(repo: string, tag: string, expiration: number): Promise<void> {
    const path = `/api/v1/repository/${repo}/tag/${tag}`;
    await request(path, "PUT", { expiration });
}

async function main() {
    console.log(`Quay URL: ${QUAY_URL}`);
    console.log(`Repository: ${REPOSITORY}`);
    console.log(`Default expiration: ${DEFAULT_EXPIRE}`);
    console.log(`Dry run: ${DRY_RUN}`);

    const tags = await getTags(REPOSITORY);
    const tagEntries = Object.entries(tags);

    if (tagEntries.length === 0) {
        console.log("No tags found.");
        return;
    }

    console.log(`Found ${tagEntries.length} tags.`);

    for (const [tag, values] of tagEntries) {
        if (values.expiration) {
            console.log(`  ${tag}: already has expiration (${values.expiration})`);
            continue;
        }

        const rule = matchRule(tag);
        if (!rule) {
            console.log(`  ${tag}: no matching rule, skipping`);
            continue;
        }

        const expireSec = toSeconds(rule.expire);
        if (expireSec === 0) {
            console.log(`  ${tag}: rule "${rule.name}" — never expires`);
            continue;
        }

        const expiryDate = getExpirationDate(expireSec);
        const expiryTs = Math.floor(Date.now() / 1000) + expireSec;

        if (DRY_RUN) {
            console.log(`  ${tag}: would set expiration to ${expiryDate} (rule: ${rule.name})`);
            continue;
        }

        try {
            await putExpiration(REPOSITORY, tag, expiryTs);
            console.log(`  ${tag}: set expiration to ${expiryDate} (rule: ${rule.name})`);
        } catch (e: any) {
            console.error(`  ${tag}: failed - ${e.message}`);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

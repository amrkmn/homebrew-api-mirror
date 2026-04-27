function isInteractiveTerminal(): boolean {
    if (!process.stdout.isTTY) return false;
    if (process.env.TERM === "dumb") return false;
    if (process.env.CI === "true" || process.env.CI === "1") return false;
    const ciEnvVars = [
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "CIRCLECI",
        "TRAVIS",
        "JENKINS_HOME",
        "BUILDKITE",
        "DRONE",
        "RENDER",
        "CF_PAGES",
        "VERCEL",
    ];
    for (const envVar of ciEnvVars) {
        if (process.env[envVar]) return false;
    }
    return true;
}

function render(line: string, done: boolean) {
    if (isInteractiveTerminal()) {
        process.stdout.write(`\r\x1b[2K  ${line}`);
        if (done) process.stdout.write("\n");
    } else if (done) {
        console.log(`  ${line}`);
    }
}

export class Progress {
    private prev = 0;
    private startTime = 0;
    private lastRender = 0;
    private startBytes = 0;
    private loggedPcts = new Set<number>();

    constructor(
        private label: string,
        private total: number,
        private mode: "bytes" | "count",
    ) {}

    start(startBytes = 0) {
        this.startTime = Date.now();
        this.startBytes = startBytes;
        this.prev = startBytes;
        this.lastRender = 0;
        this.loggedPcts = new Set();

        if (!isInteractiveTerminal()) {
            console.log(`  ${this.label}: 0%`);
        }
    }

    update(current: number) {
        const now = Date.now();
        const cappedCurrent =
            this.total > 0 ? Math.min(current, this.total) : current;
        const done = this.total > 0 && current >= this.total;

        if (isInteractiveTerminal()) {
            if (
                !done &&
                current - this.prev < Math.max(1, this.total * 0.01) &&
                now - this.lastRender < 1000
            )
                return;

            this.prev = current;
            this.lastRender = now;
        } else {
            if (!done) {
                const pct =
                    this.total > 0
                        ? Math.floor((cappedCurrent / this.total) * 100)
                        : 0;
                const milestone = Math.floor(pct / 10) * 10;
                if (milestone > 0 && !this.loggedPcts.has(milestone)) {
                    this.loggedPcts.add(milestone);
                    console.log(
                        `  ${this.label}: ${milestone}%${this.mode === "bytes" ? ` (${(cappedCurrent / 1024 / 1024).toFixed(1)}/${(this.total / 1024 / 1024).toFixed(1)} MiB)` : ` (${cappedCurrent}/${this.total})`}`,
                    );
                }
                return;
            }
        }

        const pct =
            this.total > 0
                ? ((cappedCurrent / this.total) * 100).toFixed(0)
                : "0";
        const line =
            this.mode === "bytes"
                ? (() => {
                      const secs = (now - this.startTime) / 1000;
                      const transferred = Math.max(
                          0,
                          cappedCurrent - this.startBytes,
                      );
                      const speed =
                          secs > 0
                              ? (transferred / 1024 / 1024 / secs).toFixed(1)
                              : "0.0";
                      return `${this.label} received ${(cappedCurrent / 1024 / 1024).toFixed(1)}/${(this.total / 1024 / 1024).toFixed(1)}MiB(${pct}%) ${speed}MiB/s`;
                  })()
                : `${this.label} ${cappedCurrent}/${this.total}(${pct}%)`;

        render(line, done);
    }
}
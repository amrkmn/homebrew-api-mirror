const isTTY = process.stdout.isTTY ?? false;

function render(line: string, done: boolean) {
    if (isTTY) {
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
    }

    update(current: number) {
        const now = Date.now();
        const cappedCurrent =
            this.total > 0 ? Math.min(current, this.total) : current;
        const done = this.total > 0 && current >= this.total;
        if (
            !done &&
            current - this.prev < Math.max(1, this.total * 0.01) &&
            now - this.lastRender < 1000
        )
            return;

        this.prev = current;
        this.lastRender = now;

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

const IS_TTY = (() => {
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return ![
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
  ].some((k) => process.env[k]);
})();

function toMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export class Progress {
  private prev = 0;
  private startTime = 0;
  private lastRender = 0;
  private startBytes = 0;
  private milestones = new Set<number>();

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
    this.milestones = new Set();
    if (!IS_TTY) console.log(`  ${this.fmt(startBytes, 0)}`);
  }

  update(raw: number) {
    const cur = this.total > 0 ? Math.min(raw, this.total) : raw;
    const pct = this.total > 0 ? Math.floor((cur / this.total) * 100) : 0;
    const done = this.total > 0 && raw >= this.total;
    const now = Date.now();

    if (IS_TTY) {
      if (
        !done &&
        raw - this.prev < Math.max(1, this.total * 0.01) &&
        now - this.lastRender < 1000
      )
        return;
      this.prev = raw;
      this.lastRender = now;
      process.stdout.write(
        `\r\x1b[2K  ${this.fmt(cur, pct, this.mode === "bytes")}`,
      );
      if (done) process.stdout.write("\n");
    } else if (done) {
      console.log(`  ${this.fmt(cur, 100, this.mode === "bytes")}`);
    } else {
      const m = Math.floor(pct / 10) * 10;
      if (m > 0 && !this.milestones.has(m)) {
        this.milestones.add(m);
        console.log(`  ${this.fmt(cur, m)}`);
      }
    }
  }

  private fmt(current: number, pct: number, showSpeed = false): string {
    if (this.mode === "count")
      return `${this.label} ${current}/${this.total}(${pct}%)`;
    const base = `${this.label} ${toMiB(current)}/${toMiB(this.total)}MiB(${pct}%)`;
    if (!showSpeed) return base;
    const seconds = (Date.now() - this.startTime) / 1000;
    const speed =
      seconds > 0
        ? toMiB(Math.max(0, current - this.startBytes) / seconds)
        : "0.0";
    return `${base} ${speed}MiB/s`;
  }
}

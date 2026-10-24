// pnpm grafana:check [--dir <folder>] [--static-only] [--admin] [--verbose] [--allow-dangling-links]
//
// Checks every infra/grafana/dashboards/*.json and runs every SQL query in it against ClickHouse.
// Connection: CLICKHOUSE_URL, CLICKHOUSE_DATABASE and the read-only user CLICKHOUSE_GRAFANA_USER /
// CLICKHOUSE_GRAFANA_PASSWORD (the user Grafana itself uses, so a missing GRANT shows up here).
// --admin uses CLICKHOUSE_USER / CLICKHOUSE_PASSWORD instead. --static-only skips ClickHouse.
// --allow-dangling-links turns "links to a dashboard that is not in the folder" into a warning, for
// the time while the three dashboards are still being written. CI never passes it.
import { fileURLToPath } from "node:url";
import { type CheckReport, checkDashboards, type FileReport } from "../check";
import type { ClickHouseConnection } from "../clickhouse-http";
import { connectionFromEnv } from "../connection";
import type { Problem } from "../dashboards";
import { complain, say } from "../out";

interface Args {
  dir: string;
  staticOnly: boolean;
  admin: boolean;
  verbose: boolean;
  allowDanglingLinks: boolean;
}

const DEFAULT_DIR = fileURLToPath(new URL("../../dashboards", import.meta.url));

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: DEFAULT_DIR,
    staticOnly: false,
    admin: false,
    verbose: false,
    allowDanglingLinks: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error("--dir needs a folder");
      args.dir = value;
    } else if (arg === "--static-only") args.staticOnly = true;
    else if (arg === "--admin") args.admin = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--allow-dangling-links") args.allowDanglingLinks = true;
    else
      throw new Error(
        `unknown option "${arg}" (options: --dir, --static-only, --admin, --verbose, --allow-dangling-links)`,
      );
  }
  return args;
}

// GitHub Actions turns "::error ..." lines into annotations on the pull request.
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function printProblem(problem: Problem): void {
  complain(`    - ${problem.where}`);
  for (const line of problem.message.split("\n")) complain(`        ${line}`);
  if (problem.detail) {
    for (const line of problem.detail.split("\n")) complain(`        ${line}`);
  }
}

function print(report: CheckReport, args: Args, relativeDir: string): void {
  const annotate = process.env.GITHUB_ACTIONS === "true";
  for (const file of report.files) {
    printFile(file, args);
    if (annotate) {
      for (const problem of file.problems) {
        const title = escapeProperty(`${file.title ?? file.file}: ${problem.where}`);
        say(
          `::error file=${escapeProperty(`${relativeDir}/${file.file}`)},title=${title}::${escapeData(problem.message)}`,
        );
      }
    }
  }
}

function printFile(file: FileReport, args: Args): void {
  const label = file.title ? `${file.file}  "${file.title}"` : file.file;
  if (file.problems.length === 0) {
    say(`OK    ${label}: ${file.ran.length} queries executed`);
    if (args.verbose) {
      for (const run of file.ran) say(`        ${run.where}${run.note}: ${run.rows} row(s)`);
    }
  } else {
    complain(`FAIL  ${label}: ${file.problems.length} problem(s)`);
    for (const problem of file.problems) printProblem(problem);
  }
  for (const warning of file.warnings) say(`  warning: ${warning.where}: ${warning.message}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const relativeDir = "infra/grafana/dashboards";
  let connection: ClickHouseConnection | undefined;
  if (args.staticOnly) {
    say("static checks only: no SQL is executed");
  } else {
    const described = connectionFromEnv(process.env, args.admin);
    connection = described.connection;
    say(`running every query against ${described.description}`);
  }

  const report = await checkDashboards({
    dir: args.dir,
    connection,
    allowDanglingLinks: args.allowDanglingLinks,
  });
  if (report.files.length === 0) {
    say(`no dashboards in ${args.dir}: nothing to check`);
    return 0;
  }
  print(report, args, relativeDir);
  if (report.problemCount > 0) {
    complain(
      `\n${report.problemCount} problem(s) in ${report.files.filter((f) => f.problems.length > 0).length} dashboard(s)`,
    );
    return 1;
  }
  say(`\nall ${report.files.length} dashboard(s) OK, ${report.queriesRun} queries executed`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    complain(`grafana:check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);

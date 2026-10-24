// pnpm grafana:push [--dry-run] [--force [uid]...] [--skip-health-check] [--dir <folder>]
//
// Makes the Grafana at GRAFANA_URL match the repository: the locked official folder, the team folder
// (created, never touched inside), the ClickHouse data source, dashboards and the dark default
// theme, the ClickHouse Cloud billing data source (only with CLICKHOUSE_CLOUD_KEY_ID / _SECRET; the
// Infinity plugin is installed if missing) and the alert rules of infra/grafana/alerts. GRAFANA_TOKEN is a service account token with the Admin role.
// A dashboard that somebody else saved in Grafana and that differs from the repository is refused
// (exit code 1 at the end); --force overwrites all of them, --force <uid> (repeatable) only that
// one, and pnpm grafana:pull <uid> keeps it first.
// --dry-run changes nothing. With GRAFANA_URL and GRAFANA_TOKEN set it reads Grafana and says what
// would be created, updated or left alone; without them it only prints the plan.
// See infra/grafana/README.md.
import { fileURLToPath } from "node:url";
import { loadAlertFiles } from "../alerts";
import { buildBillingDataSource, chOrgFromEnv } from "../billing";
import { loadDashboardFiles } from "../dashboards";
import { complain, say } from "../out";
import {
  buildDataSource,
  GrafanaApiError,
  GrafanaClient,
  PushError,
  parseGrafanaUrl,
  pushToGrafana,
} from "../push";

interface Args {
  dryRun: boolean;
  force: boolean;
  forceUids: string[];
  skipHealthCheck: boolean;
  dir: string;
  alertsDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    force: false,
    forceUids: [],
    skipHealthCheck: false,
    dir: fileURLToPath(new URL("../../dashboards", import.meta.url)),
    alertsDir: fileURLToPath(new URL("../../alerts", import.meta.url)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") {
      // `--force` alone: every refused dashboard. `--force <uid>` (repeatable): just that one.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        args.forceUids.push(next);
        i += 1;
      } else {
        args.force = true;
      }
    } else if (arg === "--skip-health-check") args.skipHealthCheck = true;
    else if (arg === "--dir") {
      i += 1;
      const value = argv[i];
      if (!value) throw new PushError("--dir needs a folder");
      args.dir = value;
    } else {
      throw new PushError(
        `unknown option "${arg}" (options: --dry-run, --force [uid], --skip-health-check, --dir)`,
      );
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const rawUrl = env.GRAFANA_URL;
  const token = env.GRAFANA_TOKEN;
  if (!args.dryRun && (!rawUrl || !token)) {
    throw new PushError(
      "set GRAFANA_URL and GRAFANA_TOKEN (a service account token with the Admin role); see .env.example. Use --dry-run to see the plan without them",
    );
  }
  const grafana = rawUrl ? parseGrafanaUrl(rawUrl) : { url: "http://not-set.invalid", local: true };
  const dataSource = buildDataSource(env, grafana.local);
  const files = loadDashboardFiles(args.dir);
  const alertFiles = loadAlertFiles(args.alertsDir);

  say(
    `${args.dryRun ? "DRY RUN (nothing is changed) " : ""}pushing ${files.length} dashboard(s) and ${alertFiles.length} alert group(s) to ${rawUrl ? grafana.url : "(GRAFANA_URL not set)"}`,
  );
  const result = await pushToGrafana({
    client: new GrafanaClient(grafana.url, token),
    dataSource,
    dashboardFiles: files,
    billing: buildBillingDataSource(env),
    chOrg: chOrgFromEnv(env),
    alertFiles,
    apiUrl: env.FLEETSCOPE_API_URL,
    grafanaIsLocal: grafana.local,
    dryRun: args.dryRun,
    force: args.force,
    forceUids: args.forceUids,
    canRead: Boolean(rawUrl && token),
    skipHealthCheck: args.skipHealthCheck,
    log: say,
  });

  if (result.health && !result.health.ok) {
    complain(
      "\nThe data source was saved but Grafana cannot query ClickHouse with it. Check that ClickHouse accepts connections from Grafana (on ClickHouse Cloud: the IP access list) and that the read-only user exists (pnpm db:grafana-user).",
    );
    return 1;
  }
  if (result.refused.length > 0) {
    complain(
      `\n${result.refused.length} dashboard(s) ${args.dryRun ? "would be refused" : "were NOT overwritten (everything else was pushed)"}: ${result.refused.map((r) => r.uid).join(", ")}. Keep the Grafana version with pnpm grafana:pull <uid>, or discard it with pnpm grafana:push --force <uid> (or --force for all).`,
    );
    return 1;
  }
  say(args.dryRun ? "\ndry run finished" : "\ndone");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof PushError) {
      complain(`grafana:push failed: ${error.message}`);
      if (error instanceof GrafanaApiError && error.status === 401) {
        complain(
          "The token was refused. Is GRAFANA_TOKEN a service account token that has not expired?",
        );
      }
      if (error instanceof GrafanaApiError && error.status === 403) {
        complain(
          "The token is not allowed to do that. It needs the Admin role on the service account.",
        );
      }
    } else {
      complain(`grafana:push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  },
);

// pnpm grafana:push [--dry-run] [--skip-health-check] [--dir <folder>]
//
// Makes the Grafana at GRAFANA_URL match the repository: folder, ClickHouse data source, dashboards
// and the dark default theme. GRAFANA_TOKEN is a service account token with the Admin role.
// --dry-run changes nothing. With GRAFANA_URL and GRAFANA_TOKEN set it reads Grafana and says what
// would be created, updated or left alone; without them it only prints the plan.
// See infra/grafana/README.md.
import { fileURLToPath } from "node:url";
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
  skipHealthCheck: boolean;
  dir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    skipHealthCheck: false,
    dir: fileURLToPath(new URL("../../dashboards", import.meta.url)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skip-health-check") args.skipHealthCheck = true;
    else if (arg === "--dir") {
      i += 1;
      const value = argv[i];
      if (!value) throw new PushError("--dir needs a folder");
      args.dir = value;
    } else {
      throw new PushError(
        `unknown option "${arg}" (options: --dry-run, --skip-health-check, --dir)`,
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

  say(
    `${args.dryRun ? "DRY RUN (nothing is changed) " : ""}pushing ${files.length} dashboard(s) to ${rawUrl ? grafana.url : "(GRAFANA_URL not set)"}`,
  );
  const result = await pushToGrafana({
    client: new GrafanaClient(grafana.url, token),
    dataSource,
    dashboardFiles: files,
    apiUrl: env.FLEETSCOPE_API_URL,
    grafanaIsLocal: grafana.local,
    dryRun: args.dryRun,
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

// pnpm grafana:reload [--restart]
//
// Makes the local Grafana (docker-compose, http://127.0.0.1:${GRAFANA_PORT}) load the dashboard
// files as they are now, then compares each file with what Grafana serves.
//   default    POST /api/admin/provisioning/dashboards/reload, with the admin login
//   --restart  restart the container instead (if the reload API is not enough)
// Admin login: user "admin", password GRAFANA_ADMIN_PASSWORD (default: the development password).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkStructure, loadDashboardFiles } from "../dashboards";
import { complain, say } from "../out";
import { GrafanaClient, PushError } from "../push";
import { reloadDashboards, verifyDashboards } from "../reload";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DASHBOARDS_DIR = fileURLToPath(new URL("../../dashboards", import.meta.url));
const COMPOSE = ["compose", "--project-directory", ".", "-f", "infra/docker-compose.yml"];

function parseArgs(argv: string[]): { restart: boolean } {
  let restart = false;
  for (const arg of argv) {
    if (arg === "--restart") restart = true;
    else throw new PushError(`unknown option "${arg}" (options: --restart)`);
  }
  return { restart };
}

function restartContainer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...COMPOSE, "restart", "grafana"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", (error) =>
      reject(new PushError(`cannot run docker: ${error.message} (is Docker Desktop running?)`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new PushError(`docker compose restart failed (exit ${code})`)),
    );
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new PushError(`Grafana did not become healthy at ${baseUrl} within 2 minutes`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const baseUrl = `http://127.0.0.1:${env.GRAFANA_PORT || "3001"}`;
  const password = env.GRAFANA_ADMIN_PASSWORD || "fleetscope_dev_admin";
  const client = new GrafanaClient(baseUrl, undefined, fetch, { user: "admin", password });
  const files = loadDashboardFiles(DASHBOARDS_DIR);

  say(`local Grafana at ${baseUrl}, ${files.length} dashboard file(s)`);
  let result: Awaited<ReturnType<typeof reloadDashboards>>;
  if (args.restart) {
    say("restarting the grafana container ...");
    await restartContainer();
    await waitForHealth(baseUrl);
    result = await verifyDashboards(client, checkStructure(files).dashboards, say);
  } else {
    result = await reloadDashboards({ client, dashboardFiles: files, log: say });
  }

  if (result.different.length > 0 || result.missing.length > 0) {
    complain(
      args.restart
        ? "\nGrafana still differs from the files. Check its log: docker compose --project-directory . -f infra/docker-compose.yml logs grafana"
        : "\nGrafana still differs from the files. Try: pnpm grafana:reload --restart",
    );
    return 1;
  }
  say(`\nall ${result.inSync.length} dashboard(s) in sync with the files`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    complain(`grafana:reload failed: ${message}`);
    if (error instanceof PushError && message.startsWith("cannot reach Grafana")) {
      complain("Is the local Grafana running? Start it with: pnpm infra:up");
    }
    process.exitCode = 1;
  },
);

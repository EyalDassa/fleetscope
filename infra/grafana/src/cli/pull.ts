// pnpm grafana:pull <uid> [--out <file>]
//
// Fetches a dashboard from the Grafana at GRAFANA_URL (any folder) and writes it as repository JSON,
// by default to infra/grafana/dashboards/<uid>.json. GRAFANA_TOKEN: a service account token (the
// Viewer role is enough to read). See pull.ts for what is normalised.
// Use it to keep a UI change to an official dashboard (push refused to overwrite it), or to turn a
// team dashboard into an official candidate. See infra/grafana/README.md ("For the team").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject } from "../json";
import { complain, say } from "../out";
import { fetchDashboard, pullReminder } from "../pull";
import {
  committedApiUrl,
  GrafanaApiError,
  GrafanaClient,
  PushError,
  parseGrafanaUrl,
} from "../push";

const DASHBOARDS_DIR = fileURLToPath(new URL("../../dashboards", import.meta.url));
const USAGE = "usage: grafana:pull <uid> [--out <file>] [--as <new-uid>]";

interface Args {
  uid: string;
  out: string | undefined;
  /** Write the dashboard under this new uid (to promote a team dashboard). */
  as: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let uid: string | undefined;
  let out: string | undefined;
  let as: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      i += 1;
      out = argv[i];
      if (!out) throw new PushError("--out needs a file name");
    } else if (arg === "--as") {
      i += 1;
      as = argv[i];
      if (!as || !/^[A-Za-z0-9_-]{1,40}$/.test(as)) {
        throw new PushError("--as needs a new dashboard uid (letters, digits, - and _)");
      }
    } else if (arg?.startsWith("--")) {
      throw new PushError(`unknown option "${arg}" (${USAGE})`);
    } else if (uid === undefined) {
      uid = arg;
    } else {
      throw new PushError(`only one dashboard uid at a time (${USAGE})`);
    }
  }
  if (!uid) throw new PushError(USAGE);
  return { uid, out, as };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { GRAFANA_URL: rawUrl, GRAFANA_TOKEN: token } = process.env;
  if (!rawUrl || !token) {
    throw new PushError(
      "set GRAFANA_URL and GRAFANA_TOKEN (a service account token); see .env.example",
    );
  }
  const grafana = parseGrafanaUrl(rawUrl);
  const target = args.out ?? join(DASHBOARDS_DIR, `${args.as ?? args.uid}.json`);

  // If the repo already has this dashboard, its api_url is the placeholder to restore.
  let committedUrl: string | undefined;
  let reference: unknown;
  if (existsSync(target)) {
    try {
      const old: unknown = JSON.parse(readFileSync(target, "utf8"));
      committedUrl = isObject(old) ? committedApiUrl(old) : undefined;
      reference = old;
    } catch {
      committedUrl = undefined; // an unreadable old file is simply overwritten
    }
  }
  const pulled = await fetchDashboard(
    new GrafanaClient(grafana.url, token),
    args.uid,
    committedUrl,
    reference,
    args.as,
  );

  const existed = existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pulled.text, "utf8");
  say(`${existed ? "overwrote" : "wrote"} ${target}`);
  for (const note of pulled.notes) say(`  ${note}`);
  say("");
  for (const line of pullReminder(pulled, args.uid)) say(line);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    complain(`grafana:pull failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof GrafanaApiError && (error.status === 401 || error.status === 403)) {
      complain(
        "The token was refused. Is GRAFANA_TOKEN a service account token that has not expired?",
      );
    }
    process.exitCode = 1;
  },
);

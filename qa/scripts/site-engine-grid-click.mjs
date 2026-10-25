// Live check of the "Real sites x engines" grid links against local Grafana (:3001).
// Usage: node qa/scripts/site-engine-grid-click.mjs
// Clicks the mdn x chrome-headless-shell cell, then the mdn site cell, and prints the Sessions URL and
// the site and engine of every listed session.
import { createRequire } from "node:module";

const require = createRequire("D:/Eyal/fleetscope/apps/fleet-runner/package.json");
const { chromium } = require("playwright-core");

const out = (line) => process.stdout.write(`${line}\n`);
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const from = Date.parse("2026-10-25T06:00:00Z");
const to = Date.parse("2026-10-25T07:00:00Z");

async function click(label, text) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } });
  await page.goto(
    `http://localhost:3001/d/fleetscope-browsers?from=${from}&to=${to}&var-source=real&orgId=1`,
  );
  const panel = page.locator('[data-testid*="Real sites"]').first();
  await panel.waitFor({ timeout: 30000 });
  await page.waitForTimeout(4000);
  await panel.getByText(text, { exact: true }).click();
  await page.waitForURL(/fleetscope-sessions/, { timeout: 15000 });
  await page.waitForTimeout(5000);
  out(`${label}: ${page.url()}`);
  const rows = await page.locator('[role="row"]').allTextContents();
  out(`${label}: ${rows.length - 1} session rows`);
  for (const row of rows.slice(1)) out(`  ${row}`);
  await page.close();
}

await click("cell mdn x chrome-headless-shell", "66% · n=3 · site_layout");
await click("site column mdn", "mdn");
await browser.close();

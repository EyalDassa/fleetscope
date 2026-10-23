// Entry point of `pnpm fleet`. It stays tiny on purpose: it says the runner is alive before loading
// Docker, Playwright and the rest, which takes a second or two (the first thing Eyal saw of a run
// used to be nothing at all).
const command = process.argv[2];
if (command === "run" || command === "cleanup") {
  process.stderr.write(`fleet ${command}: starting...\n`);
}

const { main } = await import("./main");

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 60, msg: "fleet runner crashed", err: String(error?.stack ?? error) })}\n`,
    );
    process.exit(1);
  },
);

// Plain stdout/stderr helpers. The repository bans console.* in committed code (Biome noConsole);
// these two are the whole output layer of the CLIs.
export function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function complain(line = ""): void {
  process.stderr.write(`${line}\n`);
}

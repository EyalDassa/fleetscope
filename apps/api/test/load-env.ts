// Load the repo's .env for integration tests. Variables already set (e.g. in CI) win.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file: rely on the real environment.
}

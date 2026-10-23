import { z } from "zod";

/** Everything the demo site reads from the environment. Validated once at startup. */
export const demoSiteEnvSchema = z.object({
  DEMO_SITE_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  /**
   * All interfaces by default, unlike the API. The browser containers reach this site through
   * host.docker.internal, which on Linux (CI) resolves to the Docker bridge address, not to
   * loopback, so a 127.0.0.1-only listener would be unreachable from them. The site holds no
   * real data (an in-memory fake shop), so listening on every interface is acceptable.
   */
  DEMO_SITE_HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type DemoSiteEnv = z.infer<typeof demoSiteEnvSchema>;

/** Throws an Error listing every invalid variable. */
export function loadDemoSiteEnv(
  env: Record<string, string | undefined> = process.env,
): DemoSiteEnv {
  const result = demoSiteEnvSchema.safeParse({
    DEMO_SITE_PORT: env.DEMO_SITE_PORT || undefined,
    DEMO_SITE_HOST: env.DEMO_SITE_HOST || undefined,
    LOG_LEVEL: env.LOG_LEVEL || undefined,
  });
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment: ${problems.join("; ")}`);
  }
  return result.data;
}

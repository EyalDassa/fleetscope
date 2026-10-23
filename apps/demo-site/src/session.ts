import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "fs_session";

/** The only account the demo accepts. The site holds no real data. */
export const DEMO_USER = "agent";
export const DEMO_PASSWORD = "fleetscope";

export interface Order {
  id: string;
  name: string;
  itemCount: number;
  totalCents: number;
}

export interface Session {
  id: string;
  user: string;
  /** Product ids, one entry per unit. */
  cart: string[];
  lastOrder: Order | null;
}

/**
 * Server-side sessions in memory, keyed by a random cookie value. Capped, so a long-running
 * fleet cannot grow it without limit: the oldest session is dropped first.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private orderCounter = 0;

  constructor(private readonly maxSessions = 5000) {}

  create(user: string): Session {
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      user,
      cart: [],
      lastOrder: null,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return session;
  }

  get(id: string | undefined): Session | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  destroy(id: string | undefined): void {
    if (id !== undefined) this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** "FS-000001", "FS-000002", ... Unique for as long as the process runs. */
  nextOrderId(): string {
    this.orderCounter += 1;
    return `FS-${String(this.orderCounter).padStart(6, "0")}`;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

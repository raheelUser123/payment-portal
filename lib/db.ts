import "server-only";
import postgres from "postgres";
import { env } from "./env";

type Sql = postgres.Sql<Record<string, never>>;

const globalForDb = globalThis as unknown as { __ppSql?: Sql };

function create(): Sql {
  return postgres(env.databaseUrl, {
    // Supabase transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: env.databaseSsl ? "require" : false,
    types: {
      // Return int8 as JS numbers (all money values are minor units < 2^53).
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => x.toString(),
        parse: (x: string) => Number(x),
      },
    },
    onnotice: () => {},
  }) as unknown as Sql;
}

function get(): Sql {
  if (!globalForDb.__ppSql) globalForDb.__ppSql = create();
  return globalForDb.__ppSql;
}

/** Lazily-initialised tagged-template SQL client (server only). */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_t, _this, args) {
    return (get() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_t, prop) {
    const s = get() as unknown as Record<string | symbol, unknown>;
    const v = s[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
  },
});

export type { Sql };

import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ALL_ORM_SCHEMAS } from "./src/infrastructure/persistence/schemas/orm-schemas";
import { Migration202610190001_InitialSchema } from "./src/infrastructure/persistence/migrations/Migration202610190001_InitialSchema";

export function buildMikroOrmOptions() {
  return defineConfig({
    entities: ALL_ORM_SCHEMAS,
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "jungle",
    password: process.env.DB_PASSWORD ?? "jungle_secret",
    dbName: process.env.DB_NAME ?? "wagering_db",
    extensions: [Migrator],
    pool: {
      min: 2,
      max: Number(process.env.DB_POOL_MAX ?? 25),
    },
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        {
          name: "Migration202610190001_InitialSchema",
          class: Migration202610190001_InitialSchema,
        },
      ],
    },
    allowGlobalContext: true,
    debug: false,
  });
}

export default buildMikroOrmOptions();

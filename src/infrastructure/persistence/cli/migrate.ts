import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmOptions } from "../../../../mikro-orm.config";

async function run() {
  const command = process.argv[2] ?? "up";
  const orm = await MikroORM.init(buildMikroOrmOptions());
  const migrator = orm.getMigrator();

  try {
    if (command === "up") {
      const executed = await migrator.up();
      console.log(
        JSON.stringify({
          event: "migrations_up",
          executed: executed.map((m) => m.name),
        }),
      );
    } else if (command === "down") {
      const reverted = await migrator.down();
      console.log(
        JSON.stringify({
          event: "migrations_down",
          reverted: reverted.map((m) => m.name),
        }),
      );
    } else if (command === "status") {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(
        JSON.stringify({
          event: "migrations_status",
          executed: executed.map((m) => m.name),
          pending: pending.map((m) => m.name),
        }),
      );
    } else {
      throw new Error(`Unknown migration command: ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});


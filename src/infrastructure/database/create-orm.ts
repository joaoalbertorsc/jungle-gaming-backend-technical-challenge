import { MikroORM } from '@mikro-orm/postgresql';
import { ENTITY_SCHEMAS } from './entities';

export interface OrmSettings {
  /** Runtime connection string (the DML-only app role). */
  readonly url: string;
  readonly poolMax?: number;
}

/**
 * Runtime MikroORM instance. `allowGlobalContext: false` forces every unit of work onto its own
 * forked EntityManager, so identity maps never leak between requests.
 */
export async function createOrm(settings: OrmSettings): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: settings.url,
    entities: ENTITY_SCHEMAS,
    allowGlobalContext: false,
    pool: { min: 0, max: settings.poolMax ?? 10 },
    debug: false,
  });
}

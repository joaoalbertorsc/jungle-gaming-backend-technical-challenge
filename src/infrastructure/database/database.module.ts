import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config/load-config';
import { UNIT_OF_WORK } from '../../shared/application/unit-of-work';
import { createOrm } from './create-orm';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

export const MIKRO_ORM = Symbol('MIKRO_ORM');

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

/** MikroORM connected as the runtime (DML-only) role, and the UnitOfWork built on it. */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: MIKRO_ORM,
          useFactory: () =>
            createOrm({ url: config.database.url, poolMax: config.database.poolMax }),
        },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) =>
            new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.database.lockTimeoutMs }),
          inject: [MIKRO_ORM],
        },
        OrmShutdown,
      ],
      exports: [MIKRO_ORM, UNIT_OF_WORK],
    };
  }
}

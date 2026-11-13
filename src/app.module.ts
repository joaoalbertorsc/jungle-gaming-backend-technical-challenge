import { type DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import type { AppConfig } from './config/load-config';
import { HealthModule } from './modules/health/health.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(config), HealthModule],
    };
  }
}

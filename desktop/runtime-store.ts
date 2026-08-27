import {
  RuntimeRepository,
  defaultRuntimeSettingsFromEnv,
  normalizeRuntimeSettings,
  openRuntimeDatabase,
  type RuntimeProfile,
  type RuntimeProfileInput,
  type RuntimeSettings,
} from '../shared/runtime-repository.js';

export type { RuntimeProfile, RuntimeProfileInput, RuntimeSettings };
export { normalizeRuntimeSettings };

export function defaultRuntimeSettings(): RuntimeSettings {
  return defaultRuntimeSettingsFromEnv();
}

export type DesktopRuntimeStore = RuntimeRepository;

export const DesktopRuntimeStore = {
  async open(dbPath: string): Promise<RuntimeRepository> {
    return openRuntimeDatabase(dbPath, defaultRuntimeSettings());
  },
};

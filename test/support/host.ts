import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type InlineExtension,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type TestHost = {
  root: string;
  faux: FauxProviderHandle;
  session: AgentSession;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  extensionsResult: LoadExtensionsResult;
  cleanup(): void;
};

export async function createTestHost(
  extensionFactories: InlineExtension[] = [],
  options: {
    faux?: RegisterFauxProviderOptions;
    extensionPaths?: string[];
    settings?: Parameters<typeof SettingsManager.inMemory>[0];
  } = {},
): Promise<TestHost> {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-check-test-"));
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    additionalExtensionPaths:
      options.extensionPaths ?? [fileURLToPath(new URL("../../index.ts", import.meta.url))],
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const faux = fauxProvider(options.faux);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const sessionManager = SessionManager.inMemory(root);
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: [],
  });

  return {
    root,
    faux,
    session,
    sessionManager,
    settingsManager,
    extensionsResult,
    cleanup() {
      session.dispose();
      modelRuntime.unregisterProvider(faux.provider.id);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

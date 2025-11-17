import { commands, ExtensionContext, window, workspace } from 'vscode';

import { OxcCommands } from './commands';
import { ConfigService } from './ConfigService';
import {
  activate as activateFormatter,
  deactivate as deactivateFormatter,
  onConfigChange as onConfigChangeFormatter,
  restartClient as restartFormatter,
  toggleClient as toggleFormatter,
} from './formatter';
import {
  activate as activateLinter,
  deactivate as deactivateLinter,
  onConfigChange as onConfigChangeLinter,
  restartClient as restartLinter,
  toggleClient as toggleLinter,
} from './linter';

const outputChannelName = 'Oxc';

export async function activate(context: ExtensionContext) {
  const configService = new ConfigService();

  const outputChannelLint = window.createOutputChannel(outputChannelName + ' (Lint)', {
    log: true,
  });

  const outputChannelFormat = window.createOutputChannel(outputChannelName + ' (Fmt)', {
    log: true,
  });

  const restartCommand = commands.registerCommand(OxcCommands.RestartServer, async () => {
    if (process.env.SKIP_LINTER_TEST !== 'true') {
      await restartLinter();
    }
    if (process.env.SKIP_FORMATTER_TEST !== 'true') {
      await restartFormatter();
    }
  });

  const showOutputCommand = commands.registerCommand(OxcCommands.ShowOutputChannel, () => {
    outputChannelLint.show();
  });

  const toggleEnable = commands.registerCommand(OxcCommands.ToggleEnable, async () => {
    await configService.vsCodeConfig.updateEnable(!configService.vsCodeConfig.enable);

    if (process.env.SKIP_LINTER_TEST !== 'true') {
      await toggleLinter(configService);
    }
    if (process.env.SKIP_FORMATTER_TEST !== 'true') {
      await toggleFormatter(configService);
    }
  });

  const onDidChangeWorkspaceFoldersDispose = workspace.onDidChangeWorkspaceFolders(async (event) => {
    for (const folder of event.added) {
      configService.addWorkspaceConfig(folder);
    }
    for (const folder of event.removed) {
      configService.removeWorkspaceConfig(folder);
    }
  });

  context.subscriptions.push(
    restartCommand,
    showOutputCommand,
    toggleEnable,
    configService,
    outputChannelLint,
    outputChannelFormat,
    onDidChangeWorkspaceFoldersDispose,
  );

  configService.onConfigChange = async function onConfigChange(event) {
    if (process.env.SKIP_LINTER_TEST !== 'true') {
      await onConfigChangeLinter(context, event, configService);
    }
    if (process.env.SKIP_FORMATTER_TEST !== 'true') {
      await onConfigChangeFormatter(context, event, configService);
    }
  };

  if (process.env.SKIP_LINTER_TEST !== 'true') {
    await activateLinter(context, outputChannelLint, configService);
  }
  if (process.env.SKIP_FORMATTER_TEST !== 'true') {
    await activateFormatter(context, outputChannelFormat, configService);
  }
}

export async function deactivate(): Promise<void> {
  if (process.env.SKIP_LINTER_TEST !== 'true') {
    await deactivateLinter();
  }
  if (process.env.SKIP_FORMATTER_TEST !== 'true') {
    await deactivateFormatter();
  }
}

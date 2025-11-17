import { promises as fsPromises } from 'node:fs';

import {
  ConfigurationChangeEvent,
  ExtensionContext,
  LogOutputChannel,
  StatusBarAlignment,
  StatusBarItem,
  ThemeColor,
  Uri,
  window,
  workspace,
} from 'vscode';

import { ConfigurationParams, MessageType, ShowMessageNotification } from 'vscode-languageclient';

import { Executable, LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

import { ConfigService } from './ConfigService';
import { OxcCommands } from './commands';

const languageClientName = 'oxc';

let client: LanguageClient | undefined;

let myStatusBarItem: StatusBarItem;

export async function activate(
  context: ExtensionContext,
  outputChannel: LogOutputChannel,
  configService: ConfigService,
) {
  async function findBinary(): Promise<string | undefined> {
    const bin = await configService.getOxfmtServerBinPath();
    if (bin) {
      try {
        await fsPromises.access(bin);
        return bin;
      } catch (e) {
        outputChannel.error(`Invalid bin path: ${bin}`, e);
      }
    }
    return process.env.SERVER_PATH_DEV;
  }

  const nodePath = configService.vsCodeConfig.nodePath;
  const serverEnv: Record<string, string> = {
    ...process.env,
    RUST_LOG: process.env.RUST_LOG || 'info',
  };
  if (nodePath) {
    serverEnv.PATH = `${nodePath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
  }

  const path = await findBinary();

  if (!path) {
    outputChannel.error('oxfmt server binary not found.');
    return;
  }

  outputChannel.info(`Using server binary at: ${path}`);

  const isNode = path.endsWith('.js') || path.endsWith('.cjs') || path.endsWith('.mjs');

  const run: Executable = isNode
    ? {
        command: 'node',
        args: [path, '--lsp'],
        options: {
          env: serverEnv,
        },
      }
    : {
        command: path,
        args: ['--lsp'],
        options: {
          // On Windows we need to run the binary in a shell to be able to execute the shell npm bin script.
          // Searching for the right `.exe` file inside `node_modules/` is not reliable as it depends on
          // the package manager used (npm, yarn, pnpm, etc) and the package version.
          // The npm bin script is a shell script that points to the actual binary.
          // Security: We validated the userDefinedBinary in `configService.getUserServerBinPath()`.
          shell: process.platform === 'win32',
          env: serverEnv,
        },
      };

  const serverOptions: ServerOptions = {
    run,
    debug: run,
  };

  // see https://github.com/oxc-project/oxc/blob/9b475ad05b750f99762d63094174be6f6fc3c0eb/crates/oxc_linter/src/loader/partial_loader/mod.rs#L17-L20
  const supportedExtensions = ['astro', 'cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'svelte', 'ts', 'tsx', 'vue'];

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [
      {
        pattern: `**/*.{${supportedExtensions.join(',')}}`,
        scheme: 'file',
      },
    ],
    initializationOptions: configService.languageServerConfig,
    outputChannel,
    traceOutputChannel: outputChannel,
    middleware: {
      workspace: {
        configuration: (params: ConfigurationParams) => {
          return params.items.map((item) => {
            if (item.section !== 'oxc_language_server') {
              return null;
            }
            if (item.scopeUri === undefined) {
              return null;
            }

            return configService.getWorkspaceConfig(Uri.parse(item.scopeUri))?.toLanguageServerConfig() ?? null;
          });
        },
      },
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(languageClientName, serverOptions, clientOptions);

  const onNotificationDispose = client.onNotification(ShowMessageNotification.type, (params) => {
    switch (params.type) {
      case MessageType.Debug:
        outputChannel.debug(params.message);
        break;
      case MessageType.Log:
        outputChannel.info(params.message);
        break;
      case MessageType.Info:
        window.showInformationMessage(params.message);
        break;
      case MessageType.Warning:
        window.showWarningMessage(params.message);
        break;
      case MessageType.Error:
        window.showErrorMessage(params.message);
        break;
      default:
        outputChannel.info(params.message);
    }
  });

  context.subscriptions.push(onNotificationDispose);

  const onDeleteFilesDispose = workspace.onDidDeleteFiles((event) => {
    for (const fileUri of event.files) {
      client?.diagnostics?.delete(fileUri);
    }
  });

  context.subscriptions.push(onDeleteFilesDispose);

  configService.onConfigChange = async function onConfigChange(event) {
    updateStatsBar(context, this.vsCodeConfig.enable);

    if (client === undefined) {
      return;
    }

    // update the initializationOptions for a possible restart
    client.clientOptions.initializationOptions = this.languageServerConfig;

    if (configService.effectsWorkspaceConfigChange(event) && client.isRunning()) {
      await client.sendNotification('workspace/didChangeConfiguration', {
        settings: this.languageServerConfig,
      });
    }
  };

  if (configService.vsCodeConfig.enable) {
    await client.start();
  }
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return undefined;
  }
  await client.stop();
  client = undefined;
}

function updateStatsBar(context: ExtensionContext, enable: boolean) {
  if (!myStatusBarItem) {
    myStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
    myStatusBarItem.command = OxcCommands.ToggleEnable;
    context.subscriptions.push(myStatusBarItem);
    myStatusBarItem.show();
  }
  let bgColor: string;
  let icon: string;
  if (!enable) {
    bgColor = 'statusBarItem.warningBackground';
    icon = '$(check)';
  } else {
    bgColor = 'statusBarItem.activeBackground';
    icon = '$(check-all)';
  }

  myStatusBarItem.text = `${icon} oxc (fmt)`;
  myStatusBarItem.backgroundColor = new ThemeColor(bgColor);
}

export async function restartClient(): Promise<void> {
  if (client === undefined) {
    window.showErrorMessage('oxc client not found');
    return;
  }

  try {
    if (client.isRunning()) {
      await client.restart();
      window.showInformationMessage('oxc server restarted.');
    } else {
      await client.start();
    }
  } catch (err) {
    client.error('Restarting client failed', err, 'force');
  }
}

export async function toggleClient(configService: ConfigService): Promise<void> {
  if (client === undefined) {
    return;
  }

  if (client.isRunning()) {
    if (!configService.vsCodeConfig.enable) {
      await client.stop();
    }
  } else {
    if (configService.vsCodeConfig.enable) {
      await client.start();
    }
  }
}

export async function onConfigChange(
  context: ExtensionContext,
  event: ConfigurationChangeEvent,
  configService: ConfigService,
): Promise<void> {
  updateStatsBar(context, configService.vsCodeConfig.enable);

  if (client === undefined) {
    return;
  }

  // update the initializationOptions for a possible restart
  client.clientOptions.initializationOptions = configService.languageServerConfig;

  if (configService.effectsWorkspaceConfigChange(event) && client.isRunning()) {
    await client.sendNotification('workspace/didChangeConfiguration', {
      settings: configService.languageServerConfig,
    });
  }
}

import tslib from 'typescript/lib/tsserverlibrary';
import * as Tokenami from '@tokenami/config';

const INVALID_SELECTOR_ERROR_CODE = 50000;
const INVALID_VALUE_ERROR_CODE = 2322;

function init(modules: { typescript: typeof tslib }) {
  const ts = modules.typescript;

  function create(info: tslib.server.PluginCreateInfo) {
    // Set up decorator object
    const proxy: tslib.LanguageService = Object.create(null);
    for (let k of Object.keys(info.languageService) as Array<keyof tslib.LanguageService>) {
      const x = info.languageService[k]!;
      // @ts-expect-error - JS runtime trickery which is tricky to type tersely
      proxy[k] = (...args: Array<{}>) => x.apply(info.languageService, args);
    }

    const cwd = info.project.getCurrentDirectory();
    const configPath = Tokenami.getConfigPath(cwd, info.config.configPath);
    const configExists = ts.sys.fileExists(configPath);

    if (!configExists) {
      info.project.projectService.logger.info(`TOKENAMI: Cannot find config`);
      return proxy;
    }

    const config = Tokenami.getConfigAtPath(configPath);
    const tokenConfigMap = new Map<string, { themeKey: string; tokenValue: string | number }>();

    // info.project.projectService.logger.info(`DEBUG:: ${JSON.stringify(config)}`);

    proxy.getSemanticDiagnostics = (fileName) => {
      const original = info.languageService.getSemanticDiagnostics(fileName);
      const program = info.languageService.getProgram();
      const sourceFile = program?.getSourceFile(fileName);

      if (sourceFile) {
        ts.forEachChild(sourceFile, function visit(node) {
          if (ts.isPropertyAssignment(node)) {
            const property = ts.isStringLiteral(node.name) ? node.name.text : null;
            const textValue = ts.isStringLiteral(node.initializer) ? node.initializer.text : null;

            if (Tokenami.TokenProperty.safeParse(property).success) {
              const parts = Tokenami.getTokenPropertyParts(property as any, config);

              if (!parts) {
                original.push({
                  file: sourceFile,
                  start: node.getStart(),
                  length: node.getWidth(),
                  messageText: `Invalid property '${property}'. Selector not found in theme.`,
                  category: ts.DiagnosticCategory.Error,
                  code: INVALID_SELECTOR_ERROR_CODE,
                });
              }

              const invalidValueIndex = original.findIndex((diagnostic) => {
                const isCodeMatch = diagnostic.code === INVALID_VALUE_ERROR_CODE;
                const isCurrentNode = diagnostic.start === node.getStart();
                return isCodeMatch && isCurrentNode;
              });

              if (invalidValueIndex > -1) {
                let messageText = `Grid values are not assignable to '${property}'.`;

                if (textValue) {
                  const arbitraryValue = textValue && Tokenami.arbitraryValue(textValue);
                  messageText = `Value '${textValue}' is not assignable to '${property}'. Use theme value or mark arbitrary with '${arbitraryValue}'`;
                }

                // @ts-ignore
                original[invalidValueIndex] = {
                  ...original[invalidValueIndex],
                  messageText,
                };
              }
            }
          }

          ts.forEachChild(node, visit);
        });
      }

      return original;
    };

    proxy.getCodeFixesAtPosition = (
      fileName,
      start,
      end,
      errorCodes,
      formatOptions,
      preferences
    ) => {
      const original = info.languageService.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        formatOptions,
        preferences
      );

      if (errorCodes.includes(INVALID_VALUE_ERROR_CODE)) {
        const program = info.languageService.getProgram();
        const sourceFile = program?.getSourceFile(fileName);

        if (sourceFile) {
          const node = findNodeAtPosition(sourceFile, start);

          if (node?.parent && tslib.isPropertyAssignment(node.parent)) {
            const assignment = node.parent;
            const valueSpan = createTextSpanFromNode(assignment.initializer);
            const value = ts.isStringLiteral(assignment.initializer) && assignment.initializer.text;

            if (value) {
              const originalText = assignment.initializer.getText();
              const arbitraryText = originalText.replace(
                /^('|")?[\w\d_-]+('|")?$/,
                `$1${Tokenami.arbitraryValue(value)}$2`
              );
              return [
                {
                  description: `Use ${arbitraryText} to mark as arbitrary`,
                  fixName: 'replaceWithArbitrary',
                  changes: [
                    {
                      fileName,
                      textChanges: [{ span: valueSpan, newText: arbitraryText }],
                    },
                  ],
                },
              ];
            }
          }
        }
      }

      return original;
    };

    proxy.getCompletionsAtPosition = (fileName, position, options) => {
      const original = info.languageService.getCompletionsAtPosition(fileName, position, options);
      if (!original) return original;

      original.entries = original.entries.map((entry) => {
        const entryName = entry.name;
        entry.sortText = entryName;

        if (Tokenami.TokenProperty.safeParse(entryName).success) {
          const parts = Tokenami.getTokenPropertyParts(entryName as any, config);
          const description = parts?.responsive && config.responsive?.[parts.responsive];
          // token properties win in sort order
          entry.sortText = `$${entryName}`;
          if (description) entry.labelDetails = { detail: '', description };
        }

        if (Tokenami.TokenValue.safeParse(entryName).success) {
          const parts = Tokenami.getTokenValueParts(entryName as any);
          const tokenValue = parts ? config.theme[parts.themeKey]?.[parts.token] : undefined;
          if (parts && tokenValue) {
            tokenConfigMap.set(parts.token, { themeKey: parts.themeKey, tokenValue });
            entry.name = `$${parts.token}`;
            entry.kindModifiers = parts.themeKey;
            entry.insertText = entryName;
            entry.labelDetails = {
              detail: '',
              description: entryName,
            };
          }
        }

        return entry;
      });

      return original;
    };

    proxy.getCompletionEntryDetails = (
      fileName,
      position,
      entryName,
      formatOptions,
      source,
      preferences,
      data
    ) => {
      const [, token] = entryName.split('$');
      const entryConfig = token ? tokenConfigMap.get(token) : undefined;
      const original = info.languageService.getCompletionEntryDetails(
        fileName,
        position,
        entryName,
        formatOptions,
        source,
        preferences,
        data
      );

      if (!entryConfig) return original;

      return {
        name: entryName,
        kind: ts.ScriptElementKind.string,
        kindModifiers: entryConfig.themeKey,
        displayParts: [{ text: String(entryConfig.tokenValue), kind: 'markdown' }],
      };
    };

    return proxy;
  }

  return { create };

  function findNodeAtPosition(
    sourceFile: tslib.SourceFile,
    position: number
  ): tslib.Node | undefined {
    function find(node: tslib.Node): tslib.Node | undefined {
      if (position >= node.getStart(sourceFile) && position < node.getEnd()) {
        return ts.forEachChild(node, find) || node;
      }
    }
    return find(sourceFile);
  }

  function createTextSpanFromNode(node: tslib.Node): tslib.TextSpan {
    return {
      start: node.getStart(),
      length: node.getEnd() - node.getStart(),
    };
  }
}

export = init;
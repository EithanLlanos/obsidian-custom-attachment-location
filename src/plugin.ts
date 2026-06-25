import type { RenameDeleteHandlerSettings } from 'obsidian-dev-utils/obsidian/components/rename-delete-handler-component';
import type { TranslationsMap } from 'obsidian-dev-utils/obsidian/i18n/i18n';

import { AppActiveFileProvider } from 'obsidian-dev-utils/obsidian/active-file-provider';
import { CommandHandlerComponent } from 'obsidian-dev-utils/obsidian/command-handlers/command-handler-component';
import { PluginCommandRegistrar } from 'obsidian-dev-utils/obsidian/command-registrar';
import { MenuEventRegistrarComponent } from 'obsidian-dev-utils/obsidian/components/menu-event-registrar-component';
import { PluginSettingsTabComponent } from 'obsidian-dev-utils/obsidian/components/plugin-settings-tab-component';
import { RenameDeleteHandlerComponent } from 'obsidian-dev-utils/obsidian/components/rename-delete-handler-component';
import { PluginDataHandler } from 'obsidian-dev-utils/obsidian/data-handler';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin';
import { PluginEventSourceImpl } from 'obsidian-dev-utils/obsidian/plugin/plugin-event-source';
import { ValueWrapper } from 'obsidian-dev-utils/value-wrapper';
import { basename, extname } from 'obsidian-dev-utils/path';

import { ArrayBufferMap } from './array-buffer-map.ts';
import { AttachmentCollector } from './attachment-collector.ts';
import { AttachmentPathManager } from './attachment-path-manager.ts';
import { AttachmentSaver } from './attachment-saver.ts';
import { CollectAttachmentsEntireVaultCommandHandler } from './command-handlers/collect-attachments-entire-vault-command-handler.ts';
import { CollectAttachmentsInCurrentFolderCommandHandler } from './command-handlers/collect-attachments-in-current-folder-command-handler.ts';
import { CollectAttachmentsInFileCommandHandler } from './command-handlers/collect-attachments-in-file-command-handler.ts';
import { MoveAttachmentToProperFolderCommandHandler } from './command-handlers/move-attachment-to-proper-folder-command-handler.ts';
import { CustomAttachmentLocationComponent } from './custom-attachment-location-component.ts';
import { translationsMap } from './i18n/locales/translations-map.ts';
import { ImageManager } from './image-manager.ts';
import { ImageSizeMap } from './image-size-map.ts';
import { MarkdownUrlMap } from './markdown-url-map.ts';
import { AppSaveAttachmentPatchComponent } from './patches/app-save-attachment-patch-component.ts';
import { PluginSettingsComponent } from './plugin-settings-component.ts';
import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { PrismComponent } from './prism-component.ts';
import { TokenValidator } from './token-validator.ts';

export class Plugin extends PluginBase {
  protected override createTranslationsMap(): TranslationsMap {
    return translationsMap;
  }

  protected override onloadImpl(): void {
    const validatorWrapper = ValueWrapper.unset<TokenValidator>();

    const pluginSettingsComponent = this.addChild(
      new PluginSettingsComponent({
        app: this.app,
        dataHandler: new PluginDataHandler(this),
        pluginEventSource: new PluginEventSourceImpl(this),
        validatorWrapper
      })
    );

    const validator = new TokenValidator({
      app: this.app,
      pluginSettingsComponent
    });

    validatorWrapper.value = validator;

    const getAvailablePathForAttachmentsOriginal = this.app.vault.getAvailablePathForAttachments.bind(this.app.vault);

    const attachmentPathManager = new AttachmentPathManager({
      app: this.app,
      getAvailablePathForAttachmentsOriginal,
      pluginSettingsComponent,
      tokenValidator: validator
    });

    const arrayBufferMap = new ArrayBufferMap({
      app: this.app
    });

    const imageSizeMap = new ImageSizeMap();
    const markdownUrlMap = new MarkdownUrlMap();
    const imageManager = new ImageManager({
      pluginSettingsComponent
    });

    const attachmentSaver = new AttachmentSaver({
      app: this.app,
      arrayBufferMap,
      attachmentPathManager,
      imageManager,
      imageSizeMap,
      markdownUrlMap,
      pluginSettingsComponent,
      tokenValidator: validator
    });

    this.addChild(
      new CustomAttachmentLocationComponent({
        app: this.app,
        arrayBufferMap,
        attachmentPathManager,
        imageSizeMap,
        markdownUrlMap,
        pluginDir: this.manifest.dir ?? '',
        pluginSettingsComponent,
        pluginVersion: this.manifest.version,
        tokenValidator: validator
      })
    );

    this.addChild(
      new PluginSettingsTabComponent({
        plugin: this,
        pluginSettingsTab: new PluginSettingsTab({
          plugin: this,
          pluginSettingsComponent
        })
      })
    );

    this.addChild(
      new RenameDeleteHandlerComponent({
        abortSignalComponent: this.abortSignalComponent,
        app: this.app,
        pluginId: this.manifest.id,
        settingsBuilder: (): Partial<RenameDeleteHandlerSettings> => ({
          emptyFolderBehavior: pluginSettingsComponent.settings.emptyFolderBehavior,
          isNote: (path: string): boolean => pluginSettingsComponent.isNoteEx(path),
          isPathIgnored: (path: string): boolean => pluginSettingsComponent.settings.isPathIgnored(path),
          shouldHandleDeletions: pluginSettingsComponent.settings.shouldDeleteOrphanAttachments,
          shouldHandleRenames: pluginSettingsComponent.settings.shouldHandleRenames,
          shouldRenameAttachmentFiles: pluginSettingsComponent.settings.shouldRenameAttachmentFiles,
          shouldRenameAttachmentFolder: pluginSettingsComponent.settings.shouldRenameAttachmentFolder,
          shouldUpdateFileNameAliases: true
        })
      })
    );

    const attachmentCollector = new AttachmentCollector({
      abortSignalComponent: this.abortSignalComponent,
      app: this.app,
      attachmentPathManager,
      consoleDebugComponent: this.consoleDebugComponent,
      pluginName: this.manifest.name,
      pluginSettingsComponent
    });

    const menuEventRegistrar = this.addChild(new MenuEventRegistrarComponent(this.app));
    this.addChild(
      new CommandHandlerComponent({
        activeFileProvider: new AppActiveFileProvider(this.app),
        commandHandlers: [
          new CollectAttachmentsInFileCommandHandler({
            attachmentCollector
          }),
          new CollectAttachmentsInCurrentFolderCommandHandler({
            attachmentCollector
          }),
          new CollectAttachmentsEntireVaultCommandHandler({
            attachmentCollector
          }),
          new MoveAttachmentToProperFolderCommandHandler({
            abortSignalComponent: this.abortSignalComponent,
            app: this.app,
            attachmentPathManager,
            pluginSettingsComponent
          })
        ],
        commandRegistrar: new PluginCommandRegistrar(this),
        menuEventRegistrar,
        pluginName: this.manifest.name
      })
    );

    this.addChild(
      new AppSaveAttachmentPatchComponent({
        app: this.app,
        attachmentSaver
      })
    );

    this.addChild(new PrismComponent());

    this.registerDomEvent(activeDocument, 'drop', this.handleGlobalDrop.bind(this, attachmentSaver, arrayBufferMap), { capture: true });
  }

  // eslint-disable-next-line complexity
  private async handleGlobalDrop(attachmentSaver: AttachmentSaver, arrayBufferMap: ArrayBufferMap, evt: DragEvent): Promise<void> {
    const target = evt.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const navFolderTitle = target.closest('.nav-folder-title');
    if (!navFolderTitle) {
      return;
    }

    const folderPath = navFolderTitle.getAttribute('data-path');
    if (folderPath === null) {
      return;
    }

    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    let hasActualFiles = false;
    for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (file && file.size > 0 && file.type.startsWith('image/')) {
            hasActualFiles = true;
        }
    }
    if (!hasActualFiles) {
      return;
    }

    evt.preventDefault();
    evt.stopPropagation();

    for (let i = 0; i < files.length; i++) {
      const file = files.item(i);
      if (!file) {
        continue;
      }
      
      if (!file.type.startsWith('image/')) {
          const arrayBuffer = await file.arrayBuffer();
          const extension = extname(file.name).slice(1);
          const baseName = basename(file.name, '.' + extension);
          
          let suffixNum = 0;
          while (true) {
            const fileName = suffixNum === 0 ? file.name : `${baseName} ${String(suffixNum)}.${extension}`;
            const path = folderPath === '/' ? fileName : `${folderPath}/${fileName}`;
            if (!this.app.vault.getAbstractFileByPath(path)) {
              await this.app.vault.createBinary(path, arrayBuffer);
              break;
            }
            suffixNum++;
          }
          continue;
      }

      const arrayBuffer = await file.arrayBuffer();
      const extension = extname(file.name).slice(1);
      const baseName = basename(file.name, '.' + extension);
      
      const fileStats = { ctime: file.lastModified, mtime: file.lastModified, size: file.size };
      
      try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          (arrayBufferMap as any).setFileStats?.(arrayBuffer, fileStats);
      } catch {
          // Ignore
      }

      await attachmentSaver.saveAttachment({
          attachmentFileBaseName: baseName,
          attachmentFileContent: arrayBuffer,
          attachmentFileExtension: extension,
          noteFilePathOverride: folderPath
      });
    }
  }
}

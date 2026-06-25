import type {
  App,
  DataWriteOptions,
  TFile
} from 'obsidian';

import { moment as moment_ } from 'obsidian';
import {
  extractDefaultExportInterop,
  normalizeOptionalProperties,
  removeUndefinedProperties
} from 'obsidian-dev-utils/object-utils';
import { makeFileName } from 'obsidian-dev-utils/path';
import { ensureNonNullable } from 'obsidian-dev-utils/type-guards';

import type { ArrayBufferMap } from './array-buffer-map.ts';
import type { AttachmentPathManager } from './attachment-path-manager.ts';
import type { ImageManager } from './image-manager.ts';
import type { ImageSizeMap } from './image-size-map.ts';
import type { MarkdownUrlMap } from './markdown-url-map.ts';
import type { PluginSettingsComponent } from './plugin-settings-component.ts';

import { AttachmentRenameMode } from './plugin-settings.ts';
import { Substitutions } from './substitutions.ts';
import {
  ActionContext,
  actionContextToAttachmentPathContext
} from './token-evaluator-context.ts';
import { TokenValidator } from './token-validator.ts';

interface AttachmentSaverConstructorParams {
  readonly app: App;
  readonly arrayBufferMap: ArrayBufferMap;
  readonly attachmentPathManager: AttachmentPathManager;
  readonly imageManager: ImageManager;
  readonly imageSizeMap: ImageSizeMap;
  readonly markdownUrlMap: MarkdownUrlMap;
  readonly pluginSettingsComponent: PluginSettingsComponent;
  readonly tokenValidator: TokenValidator;
}

const PASTED_IMAGE_NAME_REG_EXP = /Pasted image (?<Timestamp>\d{14})/;
const PASTED_IMAGE_DATE_FORMAT = 'YYYYMMDDHHmmss';
const THRESHOLD_IN_SECONDS = 10;
const moment = extractDefaultExportInterop(moment_);

interface AttachmentSaverSaveAttachmentCoreParams {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileContent: ArrayBuffer;
  readonly attachmentFileExtension: string;
  readonly noteFilePathOverride?: string;
}

interface AttachmentSaverSaveAttachmentParams {
  readonly attachmentFileBaseName: string;
  readonly attachmentFileContent: ArrayBuffer;
  readonly attachmentFileExtension: string;
  readonly noteFilePathOverride?: string;
}

export class AttachmentSaver {
  private readonly app: App;
  private readonly arrayBufferMap: ArrayBufferMap;
  private readonly attachmentPathManager: AttachmentPathManager;

  private readonly imageManager: ImageManager;
  private readonly imageSizeMap: ImageSizeMap;
  private readonly markdownUrlMap: MarkdownUrlMap;
  private readonly pluginSettingsComponent: PluginSettingsComponent;
  private readonly tokenValidator: TokenValidator;

  public constructor(params: AttachmentSaverConstructorParams) {
    this.app = params.app;
    this.arrayBufferMap = params.arrayBufferMap;
    this.attachmentPathManager = params.attachmentPathManager;
    this.imageManager = params.imageManager;
    this.imageSizeMap = params.imageSizeMap;
    this.markdownUrlMap = params.markdownUrlMap;
    this.pluginSettingsComponent = params.pluginSettingsComponent;
    this.tokenValidator = params.tokenValidator;
  }

  public async saveAttachment(params: AttachmentSaverSaveAttachmentParams): Promise<TFile> {
    let attachmentFileBaseName = params.attachmentFileBaseName;
    let attachmentFileContent = params.attachmentFileContent;
    let attachmentFileExtension = params.attachmentFileExtension;

    const activeNoteFile = this.app.workspace.getActiveFile();
    const isFolderDrop = !!params.noteFilePathOverride;
    const resolvedNoteFilePath = isFolderDrop ? params.noteFilePathOverride! : (activeNoteFile?.path ?? '');

    if (!isFolderDrop && (!activeNoteFile || this.pluginSettingsComponent.settings.isPathIgnored(activeNoteFile.path))) {
      return await this.saveAttachmentCore({
        attachmentFileBaseName,
        attachmentFileContent,
        attachmentFileExtension,
        ...(params.noteFilePathOverride !== undefined ? { noteFilePathOverride: params.noteFilePathOverride } : {})
      });
    }

    let isPastedImage = false;
    const match = PASTED_IMAGE_NAME_REG_EXP.exec(attachmentFileBaseName);
    if (match) {
      const timestampString = ensureNonNullable(match.groups?.['Timestamp']);
      const parsedDate = moment(timestampString, PASTED_IMAGE_DATE_FORMAT);
      if (parsedDate.isValid()) {
        if (moment().diff(parsedDate, 'seconds') < THRESHOLD_IN_SECONDS) {
          isPastedImage = true;
        }
      }
    }

    const convertImageToJpegResult = await this.imageManager.convertToJpeg({
      attachmentFileContent,
      attachmentFileExtension,
      isPastedImage
    });
    attachmentFileExtension = convertImageToJpegResult.attachmentFileExtension;
    attachmentFileContent = convertImageToJpegResult.attachmentFileContent;

    let shouldRename = false;

    switch (this.pluginSettingsComponent.settings.attachmentRenameMode) {
      case AttachmentRenameMode.All:
        shouldRename = true;
        break;
      case AttachmentRenameMode.None:
        break;
      case AttachmentRenameMode.OnlyPastedImages:
        shouldRename = isPastedImage;
        break;
      default:
        throw new Error('Invalid attachment rename mode');
    }

    if (shouldRename) {
      attachmentFileBaseName = await this.attachmentPathManager.getGeneratedAttachmentFileBaseName(
        new Substitutions({
          actionContext: ActionContext.SaveAttachment,
          app: this.app,
          attachmentFileContent,
          attachmentFileStats: this.arrayBufferMap.getFileStats(attachmentFileContent),
          noteFilePath: resolvedNoteFilePath,
          originalAttachmentFileName: makeFileName(attachmentFileBaseName, attachmentFileExtension),
          pluginSettingsComponent: this.pluginSettingsComponent,
          tokenValidator: this.tokenValidator
        })
      );
    }

    const attachmentFile = await this.saveAttachmentCore({
      attachmentFileBaseName,
      attachmentFileContent,
      attachmentFileExtension,
      ...(params.noteFilePathOverride !== undefined ? { noteFilePathOverride: params.noteFilePathOverride } : {})
    });
    if (this.pluginSettingsComponent.settings.markdownUrlFormat) {
      const markdownUrl = await new Substitutions({
        actionContext: ActionContext.SaveAttachment,
        app: this.app,
        attachmentFileContent,
        attachmentFileStats: this.arrayBufferMap.getFileStats(attachmentFileContent) ?? undefined,
        generatedAttachmentFileName: attachmentFile.name,
        generatedAttachmentFilePath: attachmentFile.path,
        noteFilePath: resolvedNoteFilePath,
        originalAttachmentFileName: makeFileName(attachmentFileBaseName, attachmentFileExtension),
        pluginSettingsComponent: this.pluginSettingsComponent,
        tokenValidator: this.tokenValidator
      }).fillTemplate(this.pluginSettingsComponent.settings.markdownUrlFormat);
      this.markdownUrlMap.set(attachmentFile.path, markdownUrl);
    } else {
      this.markdownUrlMap.delete(attachmentFile.path);
    }
    return attachmentFile;
  }

  private async saveAttachmentCore(params: AttachmentSaverSaveAttachmentCoreParams): Promise<TFile> {
    const noteFile = this.app.workspace.getActiveFile();
    const isFolderDrop = !!params.noteFilePathOverride;
    
    const attachmentFileStats = this.arrayBufferMap.getFileStats(params.attachmentFileContent);

    const attachmentFileContent = params.attachmentFileContent;
    
    let attachmentPath: string;
    if (isFolderDrop) {
       const folderPath = params.noteFilePathOverride!;
       attachmentPath = await this.getAvailablePathInFolder(folderPath, params.attachmentFileBaseName, params.attachmentFileExtension);
    } else {
       attachmentPath = await this.attachmentPathManager.getAvailablePathForAttachments({
         attachmentFileBaseName: params.attachmentFileBaseName,
         attachmentFileExtension: params.attachmentFileExtension,
         attachmentFileStats,
         context: actionContextToAttachmentPathContext(ActionContext.SaveAttachment),
         notePathOrFile: noteFile,
         oldAttachmentPathOrFile: makeFileName(params.attachmentFileBaseName, params.attachmentFileExtension),
         readAttachmentFileContent: (): Promise<ArrayBuffer> => Promise.resolve(attachmentFileContent),
         shouldSkipDuplicateCheck: false,
         shouldSkipGeneratedAttachmentFileName: true,
         shouldSkipMissingAttachmentFolderCreation: false
       });
    }

    const imageSize = await this.imageManager.getImageSize({
      content: params.attachmentFileContent,
      extension: params.attachmentFileExtension
    });
    if (imageSize !== null) {
      this.imageSizeMap.set(attachmentPath, imageSize);
    }

    return await this.app.vault.createBinary(
      attachmentPath,
      params.attachmentFileContent,
      removeUndefinedProperties(normalizeOptionalProperties<DataWriteOptions>({
        ctime: attachmentFileStats?.ctime ? Math.trunc(attachmentFileStats.ctime) : undefined,
        mtime: attachmentFileStats?.mtime ? Math.trunc(attachmentFileStats.mtime) : undefined
      }))
    );
  }

  private async getAvailablePathInFolder(folderPath: string, baseName: string, extension: string): Promise<string> {
    let suffixNum = 0;
    while (true) {
      const fileName = makeFileName(
        suffixNum === 0 ? baseName : `${baseName}${this.pluginSettingsComponent.settings.duplicateNameSeparator}${String(suffixNum)}`,
        extension
      );
      const path = folderPath === '/' ? fileName : `${folderPath}/${fileName}`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        return path;
      }
      suffixNum++;
    }
  }
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import * as resources from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IDecodeStreamOptions, toDecodeStream, encodeStream } from 'vs/base/node/encoding';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/resourceConfiguration';
import { localize } from 'vs/nls';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { FileOperation, FileOperationError, FileOperationEvent, FileOperationResult, FileWriteOptions, FileSystemProviderCapabilities, IContent, ICreateFileOptions, IFileSystemProvider, IResolveContentOptions, IStreamContent, ITextSnapshot, IUpdateContentOptions, StringSnapshot, ILegacyFileService, IFileService, toFileOperationResult, IFileStatWithMetadata } from 'vs/platform/files/common/files';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { LegacyFileService } from 'vs/workbench/services/files/node/fileService';
import { createReadableOfProvider, createReadableOfSnapshot, createWritableOfProvider } from 'vs/workbench/services/files/node/streams';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';

export class LegacyRemoteFileService extends LegacyFileService {

	private readonly _provider: Map<string, IFileSystemProvider>;

	constructor(
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
	) {
		super(
			fileService,
			contextService,
			environmentService,
			textResourceConfigurationService
		);

		this._provider = new Map<string, IFileSystemProvider>();
	}

	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		if (this._provider.has(scheme)) {
			throw new Error('a provider for that scheme is already registered');
		}

		this._provider.set(scheme, provider);

		return {
			dispose: () => {
				this._provider.delete(scheme);
			}
		};
	}

	// --- stat

	private _withProvider(resource: URI): Promise<IFileSystemProvider> {
		if (!resources.isAbsolutePath(resource)) {
			throw new FileOperationError(
				localize('invalidPath', "The path of resource '{0}' must be absolute", resource.toString(true)),
				FileOperationResult.FILE_INVALID_PATH
			);
		}

		return Promise.all([
			this.fileService.activateProvider(resource.scheme)
		]).then(() => {
			const provider = this._provider.get(resource.scheme);
			if (!provider) {
				const err = new Error();
				err.name = 'ENOPRO';
				err.message = `no provider for ${resource.toString()}`;
				throw err;
			}
			return provider;
		});
	}

	// --- resolve

	resolveContent(resource: URI, options?: IResolveContentOptions): Promise<IContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveContent(resource, options);
		} else {
			return this._readFile(resource, options).then(LegacyRemoteFileService._asContent);
		}
	}

	resolveStreamContent(resource: URI, options?: IResolveContentOptions): Promise<IStreamContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveStreamContent(resource, options);
		} else {
			return this._readFile(resource, options);
		}
	}

	private _readFile(resource: URI, options: IResolveContentOptions = Object.create(null)): Promise<IStreamContent> {
		return this._withProvider(resource).then(provider => {

			return this.fileService.resolve(resource).then(fileStat => {

				if (fileStat.isDirectory) {
					// todo@joh cannot copy a folder
					// https://github.com/Microsoft/vscode/issues/41547
					throw new FileOperationError(
						localize('fileIsDirectoryError', "File is directory"),
						FileOperationResult.FILE_IS_DIRECTORY,
						options
					);
				}
				if (typeof options.etag === 'string' && fileStat.etag === options.etag) {
					throw new FileOperationError(
						localize('fileNotModifiedError', "File not modified since"),
						FileOperationResult.FILE_NOT_MODIFIED_SINCE,
						options
					);
				}

				const decodeStreamOpts: IDecodeStreamOptions = {
					guessEncoding: options.autoGuessEncoding,
					overwriteEncoding: detected => {
						return this.encoding.getReadEncoding(resource, options, { encoding: detected, seemsBinary: false });
					}
				};

				const readable = createReadableOfProvider(provider, resource, options.position || 0);

				return toDecodeStream(readable, decodeStreamOpts).then(data => {

					if (options.acceptTextOnly && data.detected.seemsBinary) {
						return Promise.reject<any>(new FileOperationError(
							localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
							FileOperationResult.FILE_IS_BINARY,
							options
						));
					}

					return <IStreamContent>{
						encoding: data.detected.encoding,
						value: data.stream,
						resource: fileStat.resource,
						name: fileStat.name,
						etag: fileStat.etag,
						mtime: fileStat.mtime,
						isReadonly: fileStat.isReadonly,
						size: fileStat.size
					};
				});
			});
		});
	}

	// --- saving

	private static _throwIfFileSystemIsReadonly(provider: IFileSystemProvider): IFileSystemProvider {
		if (provider.capabilities & FileSystemProviderCapabilities.Readonly) {
			throw new FileOperationError(localize('err.readonly', "Resource can not be modified."), FileOperationResult.FILE_PERMISSION_DENIED);
		}
		return provider;
	}

	createFile(resource: URI, content?: string, options?: ICreateFileOptions): Promise<IFileStatWithMetadata> {
		if (resource.scheme === Schemas.file) {
			return super.createFile(resource, content, options);
		} else {

			return this._withProvider(resource).then(LegacyRemoteFileService._throwIfFileSystemIsReadonly).then(provider => {

				return this.fileService.createFolder(resources.dirname(resource)).then(() => {
					const { encoding } = this.encoding.getWriteEncoding(resource);
					return this._writeFile(provider, resource, new StringSnapshot(content || ''), encoding, { create: true, overwrite: Boolean(options && options.overwrite) });
				});

			}).then(fileStat => {
				this._onAfterOperation.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));
				return fileStat;
			}, err => {
				const message = localize('err.create', "Failed to create file {0}", resource.toString(false));
				const result = toFileOperationResult(err);
				throw new FileOperationError(message, result, options);
			});
		}
	}

	updateContent(resource: URI, value: string | ITextSnapshot, options?: IUpdateContentOptions): Promise<IFileStatWithMetadata> {
		if (resource.scheme === Schemas.file) {
			return super.updateContent(resource, value, options);
		} else {
			return this._withProvider(resource).then(LegacyRemoteFileService._throwIfFileSystemIsReadonly).then(provider => {
				return this.fileService.createFolder(resources.dirname(resource)).then(() => {
					const snapshot = typeof value === 'string' ? new StringSnapshot(value) : value;
					return this._writeFile(provider, resource, snapshot, options && options.encoding, { create: true, overwrite: true });
				});
			});
		}
	}

	private _writeFile(provider: IFileSystemProvider, resource: URI, snapshot: ITextSnapshot, preferredEncoding: string | undefined = undefined, options: FileWriteOptions): Promise<IFileStatWithMetadata> {
		const readable = createReadableOfSnapshot(snapshot);
		const { encoding, hasBOM } = this.encoding.getWriteEncoding(resource, preferredEncoding);
		const encoder = encodeStream(encoding, { addBOM: hasBOM });
		const target = createWritableOfProvider(provider, resource, options);
		return new Promise((resolve, reject) => {
			readable.pipe(encoder).pipe(target);
			target.once('error', err => reject(err));
			target.once('finish', (_: unknown) => resolve(undefined));
		}).then(_ => {
			return this.fileService.resolve(resource, { resolveMetadata: true }) as Promise<IFileStatWithMetadata>;
		});
	}

	private static _asContent(content: IStreamContent): Promise<IContent> {
		return new Promise<IContent>((resolve, reject) => {
			let result: IContent = {
				value: '',
				encoding: content.encoding,
				etag: content.etag,
				size: content.size,
				mtime: content.mtime,
				name: content.name,
				resource: content.resource,
				isReadonly: content.isReadonly
			};
			content.value.on('data', chunk => result.value += chunk);
			content.value.on('error', reject);
			content.value.on('end', () => resolve(result));
		});
	}
}

registerSingleton(ILegacyFileService, LegacyRemoteFileService);
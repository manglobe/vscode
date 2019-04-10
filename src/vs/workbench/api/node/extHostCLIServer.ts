/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateRandomPipeName } from 'vs/base/parts/ipc/node/ipc.net';
import * as http from 'http';
import * as fs from 'fs';
import { ExtHostCommands } from 'vs/workbench/api/node/extHostCommands';
import { IURIToOpen, IOpenSettings } from 'vs/platform/windows/common/windows';
import { URI } from 'vs/base/common/uri';
import { hasWorkspaceFileExtension } from 'vs/platform/workspaces/common/workspaces';

export interface OpenCommandPipeArgs {
	type: 'open';
	fileURIs?: string[];
	folderURIs: string[];
	forceNewWindow?: boolean;
	diffMode?: boolean;
	addMode?: boolean;
	forceReuseWindow?: boolean;
	waitMarkerFilePath?: string;
}

export interface StatusPipeArgs {
	type: 'status';
}

export class CLIServer {

	private _server: http.Server;
	private _ipcHandlePath: string | undefined;

	constructor(private _commands: ExtHostCommands) {
		this._server = http.createServer((req, res) => this.onRequest(req, res));
		this.setup().catch(err => {
			console.error(err);
			return '';
		});
	}

	public get ipcHandlePath() {
		return this._ipcHandlePath;
	}

	private async setup(): Promise<string> {
		this._ipcHandlePath = generateRandomPipeName();

		try {
			this._server.listen(this.ipcHandlePath);
			this._server.on('error', err => console.error(err));
		} catch (err) {
			console.error('Could not start open from terminal server.');
		}

		return this._ipcHandlePath;
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const chunks: string[] = [];
		req.setEncoding('utf8');
		req.on('data', (d: string) => chunks.push(d));
		req.on('end', () => {
			const data: OpenCommandPipeArgs | StatusPipeArgs | any = JSON.parse(chunks.join(''));
			switch (data.type) {
				case 'open':
					this.open(data, res);
					break;
				case 'status':
					this.getStatus(data, res);
					break;
				default:
					res.writeHead(404);
					res.write(`Unkown message type: ${data.type}`, err => {
						if (err) {
							console.error(err);
						}
					});
					res.end();
					break;
			}
		});
	}

	private open(data: OpenCommandPipeArgs, res: http.ServerResponse) {
		let { fileURIs, folderURIs, forceNewWindow, diffMode, addMode, forceReuseWindow, waitMarkerFilePath } = data;
		const urisToOpen: IURIToOpen[] = [];
		if (Array.isArray(folderURIs)) {
			for (const s of folderURIs) {
				try {
					urisToOpen.push({ folderUri: URI.parse(s) });
					forceNewWindow = true;
				} catch (e) {
					// ignore
				}
			}
		}
		if (Array.isArray(fileURIs)) {
			for (const s of fileURIs) {
				try {
					if (hasWorkspaceFileExtension(s)) {
						urisToOpen.push({ workspaceUri: URI.parse(s) });
						forceNewWindow = true;
					} else {
						urisToOpen.push({ fileUri: URI.parse(s) });
					}
				} catch (e) {
					// ignore
				}
			}
		}
		if (urisToOpen.length) {
			const waitMarkerFileURI = waitMarkerFilePath ? URI.file(waitMarkerFilePath) : undefined;
			const windowOpenArgs: IOpenSettings = { forceNewWindow, diffMode, addMode, forceReuseWindow, waitMarkerFileURI };
			this._commands.executeCommand('_files.windowOpen', urisToOpen, windowOpenArgs);
		}
		res.writeHead(200);
		res.end();
	}

	private async getStatus(data: StatusPipeArgs, res: http.ServerResponse) {
		try {
			const status = await this._commands.executeCommand('_issues.getSystemStatus');
			res.writeHead(200);
			res.write(status);
			res.end();
		} catch (err) {
			res.writeHead(500);
			res.write(String(err), err => {
				if (err) {
					console.error(err);
				}
			});
			res.end();
		}
	}

	dispose(): void {
		this._server.close();

		if (this._ipcHandlePath && process.platform !== 'win32' && fs.existsSync(this._ipcHandlePath)) {
			fs.unlinkSync(this._ipcHandlePath);
		}
	}
}

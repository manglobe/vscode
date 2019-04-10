/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Disposable } from 'vs/base/common/lifecycle';
import { IChannel, IServerChannel, getDelayedChannel } from 'vs/base/parts/ipc/common/ipc';
import { Client } from 'vs/base/parts/ipc/common/ipc.net';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { connectRemoteAgentManagement, IConnectionOptions, IWebSocketFactory } from 'vs/platform/remote/common/remoteAgentConnection';
import { IRemoteAgentConnection, IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { RemoteAgentConnectionContext, IRemoteAgentEnvironment } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { RemoteExtensionEnvironmentChannelClient } from 'vs/workbench/services/remote/common/remoteAgentEnvironmentChannel';
import { INotificationService } from 'vs/platform/notification/common/notification';

export abstract class AbstractRemoteAgentService extends Disposable implements IRemoteAgentService {

	_serviceBrand: any;

	private _environment: Promise<IRemoteAgentEnvironment | null> | null;

	constructor(
		@IEnvironmentService protected readonly _environmentService: IEnvironmentService
	) {
		super();
	}

	abstract getConnection(): IRemoteAgentConnection | null;

	getEnvironment(bail?: boolean): Promise<IRemoteAgentEnvironment | null> {
		if (!this._environment) {
			const connection = this.getConnection();
			if (connection) {
				const client = new RemoteExtensionEnvironmentChannelClient(connection.getChannel('remoteextensionsenvironment'));
				this._environment = client.getEnvironmentData(connection.remoteAuthority, this._environmentService.extensionDevelopmentLocationURI);
			} else {
				this._environment = Promise.resolve(null);
			}
		}
		return bail ? this._environment : this._environment.then(undefined, () => null);
	}
}

export class RemoteAgentConnection extends Disposable implements IRemoteAgentConnection {

	readonly remoteAuthority: string;
	private _connection: Promise<Client<RemoteAgentConnectionContext>> | null;

	constructor(
		remoteAuthority: string,
		private _commit: string | undefined,
		private _webSocketFactory: IWebSocketFactory,
		private _environmentService: IEnvironmentService,
		private _remoteAuthorityResolverService: IRemoteAuthorityResolverService
	) {
		super();
		this.remoteAuthority = remoteAuthority;
		this._connection = null;
	}

	getChannel<T extends IChannel>(channelName: string): T {
		return <T>getDelayedChannel(this._getOrCreateConnection().then(c => c.getChannel(channelName)));
	}

	registerChannel<T extends IServerChannel<RemoteAgentConnectionContext>>(channelName: string, channel: T): void {
		this._getOrCreateConnection().then(client => client.registerChannel(channelName, channel));
	}

	private _getOrCreateConnection(): Promise<Client<RemoteAgentConnectionContext>> {
		if (!this._connection) {
			this._connection = this._createConnection();
		}
		return this._connection;
	}

	private async _createConnection(): Promise<Client<RemoteAgentConnectionContext>> {
		const options: IConnectionOptions = {
			isBuilt: this._environmentService.isBuilt,
			commit: this._commit,
			webSocketFactory: this._webSocketFactory,
			addressProvider: {
				getAddress: async () => {
					const { host, port } = await this._remoteAuthorityResolverService.resolveAuthority(this.remoteAuthority);
					return { host, port };
				}
			}
		};
		const connection = await connectRemoteAgentManagement(options, this.remoteAuthority, `renderer`);
		this._register(connection);
		return connection.client;
	}
}

class RemoteConnectionFailureNotificationContribution implements IWorkbenchContribution {

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@INotificationService notificationService: INotificationService,
	) {
		// Let's cover the case where connecting to fetch the remote extension info fails
		remoteAgentService.getEnvironment(true)
			.then(undefined, err => notificationService.error(nls.localize('connectionError', "Failed to connect to the remote extension host agent (Error: {0})", err ? err.message : '')));
	}

}

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(Extensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(RemoteConnectionFailureNotificationContribution, LifecyclePhase.Ready);

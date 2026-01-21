import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

const DEFAULT_BASE_URL = 'https://api.soniox.com';

export class SonioxApi implements ICredentialType {
	name = 'sonioxApi';
	displayName = 'Soniox API';
	icon: Icon = { light: 'file:../icons/soniox.svg', dark: 'file:../icons/soniox.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
			},
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_BASE_URL,
			description: 'Override for Soniox API base URL',
		},
	];

	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const baseUrl = (credentials.baseUrl as string) || DEFAULT_BASE_URL;
		requestOptions.baseURL = baseUrl.replace(/\/$/, '');
		requestOptions.headers = {
			...(requestOptions.headers ?? {}),
			Authorization: `Bearer ${credentials.apiKey}`,
		};

		return requestOptions;
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/transcriptions/credential-test',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message: 'Authentication failed. Verify your Soniox API key.',
				},
			},
		],
	};

	documentationUrl = 'https://soniox.com/docs/stt/integrations/n8n';
}

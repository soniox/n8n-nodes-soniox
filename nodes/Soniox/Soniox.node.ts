import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError, sleepWithAbort } from 'n8n-workflow';

const SONIOX_CREDENTIALS = 'sonioxApi';
const STATUS_COMPLETED = 'completed';
const STATUS_ERROR = 'error';

interface PollOptions {
	transcriptionId: string;
	pollIntervalSec: number;
	maxWaitSec: number;
}

interface TranscriptResult {
	status: IDataObject;
	transcript: IDataObject;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function redactWebhookAuthHeaderValue(data: IDataObject): IDataObject {
	if (!data || typeof data !== 'object') return data;
	if (!Object.prototype.hasOwnProperty.call(data, 'webhook_auth_header_value')) return data;

	return {
		...data,
		webhook_auth_header_value: '[REDACTED]',
	};
}

function parseStructuredContext(value: unknown): IDataObject | undefined {
	if (!value) return undefined;

	// Already an object (n8n parsed it)
	if (typeof value === 'object' && !Array.isArray(value)) {
		return Object.keys(value).length > 0 ? (value as IDataObject) : undefined;
	}

	// String - need to parse
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return undefined;

		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new ApplicationError('Context must be a JSON object, not an array or primitive');
		}
		return Object.keys(parsed).length > 0 ? (parsed as IDataObject) : undefined;
	}

	return undefined;
}

function normalizeLanguageHints(input: IDataObject): string[] {
	if (!input || typeof input !== 'object') {
		return [];
	}

	const languages = input.languages as IDataObject[] | undefined;
	if (!Array.isArray(languages)) {
		return [];
	}

	return languages.map((entry) => entry.code).filter(isNonEmptyString);
}

interface SonioxApiError {
	message?: string;
	description?: string;
	httpCode?: number;
	cause?: {
		message?: string;
		code?: string;
		error?: { message?: string; detail?: string; code?: string };
	};
	response?: {
		statusCode?: number;
		body?: { message?: string; detail?: string; error?: string; code?: string };
	};
}

function getErrorHint(statusCode: number | undefined, errorCode: string | undefined): string {
	// Check for specific error codes first
	if (errorCode) {
		const codeHints: Record<string, string> = {
			invalid_api_key: 'Check that your API key is correct in the Soniox credentials.',
			insufficient_credits: 'Your Soniox account may need more credits. Visit dashboard.soniox.com.',
			file_too_large: 'The audio file exceeds the maximum size limit. Try a smaller file.',
			unsupported_format: 'This audio format is not supported. Supported formats include WAV, MP3, FLAC, and more.',
			transcription_not_found: 'The transcription ID does not exist or has been deleted.',
			rate_limit_exceeded: 'You have exceeded the API rate limit. Wait a moment and try again.',
		};
		if (codeHints[errorCode]) {
			return codeHints[errorCode];
		}
	}

	// Fall back to HTTP status code hints
	if (statusCode) {
		const statusHints: Record<number, string> = {
			400: 'Check your request parameters. The API received invalid input.',
			401: 'Authentication failed. Verify your Soniox API key in the credentials.',
			403: 'Access denied. Your API key may not have permission for this operation.',
			404: 'Resource not found. The transcription ID may be invalid or deleted.',
			413: 'The audio file is too large. Try a smaller file or use a URL instead.',
			422: 'Invalid request data. Check that all required fields are filled correctly.',
			429: 'Rate limit exceeded. Wait a moment before retrying.',
			500: 'Soniox server error. Try again later or contact Soniox support.',
			502: 'Soniox service temporarily unavailable. Try again in a few moments.',
			503: 'Soniox service is under maintenance. Try again later.',
		};
		if (statusHints[statusCode]) {
			return statusHints[statusCode];
		}
	}

	return '';
}

function extractErrorDetails(error: SonioxApiError): {
	message: string;
	statusCode: number | undefined;
	errorCode: string | undefined;
} {
	let detail = '';

	// Extract status code
	const statusCode = error.httpCode || error.response?.statusCode;

	// Extract error code
	const errorCode =
		error.cause?.error?.code || error.cause?.code || error.response?.body?.code || undefined;

	// Extract message
	if (error.cause?.error?.detail) {
		detail = error.cause.error.detail;
	} else if (error.cause?.error?.message) {
		detail = error.cause.error.message;
	} else if (error.response?.body?.detail) {
		detail = error.response.body.detail;
	} else if (error.response?.body?.message) {
		detail = error.response.body.message;
	} else if (error.response?.body?.error) {
		detail = error.response.body.error;
	} else if (error.description) {
		detail = error.description;
	} else if (error.message) {
		detail = error.message;
	}

	return { message: detail, statusCode, errorCode };
}

async function sonioxApiRequest(
	this: IExecuteFunctions,
	options: {
		method: IHttpRequestMethods;
		url: string;
		body?: IDataObject;
		headers?: IDataObject;
	},
) {
	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, SONIOX_CREDENTIALS, {
			method: options.method,
			url: options.url,
			body: options.body,
			headers: options.headers,
			json: true,
		});
	} catch (error: unknown) {
		const { message, statusCode, errorCode } = extractErrorDetails(error as SonioxApiError);
		const hint = getErrorHint(statusCode, errorCode);

		let errorMessage = 'Soniox API error';
		if (message) {
			errorMessage = `Soniox API error: ${message}`;
		} else if (statusCode) {
			errorMessage = `Soniox API error (HTTP ${statusCode})`;
		}

		throw new NodeOperationError(this.getNode(), errorMessage, {
			description: hint || undefined,
		});
	}
}

function createMultipartPayload(fileBuffer: Buffer, fileName: string, contentType: string) {
	const boundary = `----n8nFormBoundary${Date.now().toString(16)}${Math.random()
		.toString(16)
		.slice(2)}`;
	const safeFileName = fileName.replace(/[\r\n"]/g, '');
	const lineBreak = '\r\n';

	const header = [
		`--${boundary}`,
		`Content-Disposition: form-data; name="file"; filename="${safeFileName}"`,
		`Content-Type: ${contentType}`,
		'',
		'',
	].join(lineBreak);

	const footer = `${lineBreak}--${boundary}--${lineBreak}`;

	return {
		body: Buffer.concat([
			Buffer.from(header, 'utf8'),
			fileBuffer,
			Buffer.from(footer, 'utf8'),
		]),
		headers: {
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
		} as IDataObject,
	};
}

async function uploadFile(
	this: IExecuteFunctions,
	itemIndex: number,
	binaryPropertyName: string,
) {
	const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);

	const fileName =
		binaryData.fileName ||
		(binaryData.fileExtension ? `audio.${binaryData.fileExtension}` : 'audio');
	const contentType = binaryData.mimeType || 'application/octet-stream';

	const multipart = createMultipartPayload(buffer, fileName, contentType);

	const response = await this.helpers.httpRequestWithAuthentication.call(
		this,
		SONIOX_CREDENTIALS,
		{
			method: 'POST',
			url: '/v1/files',
			body: multipart.body,
			headers: multipart.headers,
			json: false,
		},
	);

	let uploadResponse: IDataObject | null = null;
	if (response && typeof response === 'object' && !Buffer.isBuffer(response)) {
		uploadResponse = response as IDataObject;
	} else if (response) {
		const responseText = Buffer.isBuffer(response) ? response.toString('utf8') : String(response);
		try {
			uploadResponse = JSON.parse(responseText) as IDataObject;
		} catch {
			uploadResponse = null;
		}
	}

	if (!uploadResponse?.id) {
		throw new NodeOperationError(this.getNode(), 'File upload did not return a file ID', {
			description: 'The file upload response was unexpected. Ensure the file is a valid audio file and try again.',
		});
	}

	return uploadResponse.id as string;
}

async function pollForCompletion(
	this: IExecuteFunctions,
	options: PollOptions,
): Promise<TranscriptResult> {
	const { transcriptionId, pollIntervalSec, maxWaitSec } = options;
	const timeoutAt = Date.now() + Math.max(1, maxWaitSec) * 1000;
	const pollDelay = Math.max(1, pollIntervalSec) * 1000;

	let statusResponse: IDataObject | undefined;

	while (true) {
		statusResponse = (await sonioxApiRequest.call(this, {
			method: 'GET',
			url: `/v1/transcriptions/${transcriptionId}`,
		})) as IDataObject;

		const status = statusResponse?.status as string | undefined;

		if (status === STATUS_COMPLETED) {
			break;
		}

		if (status === STATUS_ERROR) {
			const errorMessage = statusResponse?.error_message
				? `: ${statusResponse.error_message}`
				: '';
			throw new NodeOperationError(
				this.getNode(),
				`Transcription failed with status "${STATUS_ERROR}"${errorMessage}`,
				{
					description: 'The transcription could not be completed. Check that the audio file is valid and in a supported format.',
				},
			);
		}

		if (Date.now() > timeoutAt) {
			const statusText = status ? ` (last status: ${status})` : '';
			throw new NodeOperationError(
				this.getNode(),
				`Polling timed out after ${maxWaitSec} seconds${statusText}`,
				{
					description: 'The transcription is taking longer than expected. Try increasing the "Max Wait" setting, or disable "Wait for Completion" and fetch results later.',
				},
			);
		}

		await sleepWithAbort(pollDelay, this.getExecutionCancelSignal?.());
	}

	const transcript = (await sonioxApiRequest.call(this, {
		method: 'GET',
		url: `/v1/transcriptions/${transcriptionId}/transcript`,
	})) as IDataObject;

	return {
		status: statusResponse!,
		transcript,
	};
}

interface DeleteResult {
	deleted: {
		transcription?: string;
		file?: string;
	};
	warnings: string[];
}

async function tryDeleteResource(
	this: IExecuteFunctions,
	url: string,
	description: string,
): Promise<string | null> {
	try {
		await this.helpers.httpRequestWithAuthentication.call(this, SONIOX_CREDENTIALS, {
			method: 'DELETE',
			url,
			json: true,
		});
		return null;
	} catch (error: unknown) {
		const { message } = extractErrorDetails(error as SonioxApiError);
		return `Failed to delete ${description}: ${message || 'Unknown error'}`;
	}
}

async function deleteResources(
	this: IExecuteFunctions,
	transcriptionId?: string,
	fileId?: string,
): Promise<DeleteResult> {
	const result: DeleteResult = {
		deleted: {},
		warnings: [],
	};

	if (transcriptionId) {
		const warning = await tryDeleteResource.call(
			this,
			`/v1/transcriptions/${transcriptionId}`,
			`transcription ${transcriptionId}`,
		);
		if (warning) {
			result.warnings.push(warning);
		} else {
			result.deleted.transcription = transcriptionId;
		}
	}

	if (fileId) {
		const warning = await tryDeleteResource.call(
			this,
			`/v1/files/${fileId}`,
			`file ${fileId}`,
		);
		if (warning) {
			result.warnings.push(warning);
		} else {
			result.deleted.file = fileId;
		}
	}

	return result;
}

export class Soniox implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Soniox',
		name: 'soniox',
		icon: { light: 'file:../../icons/soniox.svg', dark: 'file:../../icons/soniox.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Create Soniox transcriptions and fetch results',
		defaults: {
			name: 'Soniox',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: SONIOX_CREDENTIALS,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Transcription',
						value: 'transcription',
					},
				],
				default: 'transcription',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['transcription'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a transcription',
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete transcription and or file',
					},
					{
						name: 'Get Results',
						value: 'getResults',
						action: 'Get transcription results',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Audio Source',
				name: 'audioSource',
				type: 'options',
				required: true,
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
				options: [
					{
						name: 'Binary File',
						value: 'binary',
					},
					{
						name: 'Audio URL',
						value: 'url',
					},
					{
						name: 'File ID',
						value: 'fileId',
					},
				],
				default: 'binary',
			},
			{
				displayName: 'Binary Property Name',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				description: 'Name of the binary property that contains the audio file',
				typeOptions: {
					binaryDataProperty: true,
				},
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						audioSource: ['binary'],
					},
				},
			},
			{
				displayName: 'Audio URL',
				name: 'audioUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/audio.wav',
				description: 'Public URL to the audio file',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						audioSource: ['url'],
					},
				},
			},
			{
				displayName: 'File ID',
				name: 'fileId',
				type: 'string',
				default: '',
				required: true,
				description: 'ID of a previously uploaded Soniox file',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						audioSource: ['fileId'],
					},
				},
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'stt-async-v3',
				required: true,
				description: 'Soniox model ID to use for transcription',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Language Hints',
				name: 'languageHints',
				type: 'fixedCollection',
				default: {},
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Language',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
				options: [
					{
						displayName: 'Languages',
						name: 'languages',
						values: [
							{
								displayName: 'Language Code',
								name: 'code',
								type: 'string',
								default: '',
								placeholder: 'en',
								description: 'Language code (e.g., en, fr, de, es)',
							},
						],
					},
				],
			},
			{
				displayName: 'Language Hints Strict',
				name: 'languageHintsStrict',
				type: 'boolean',
				default: false,
				description: 'Whether to treat language hints as strict constraints',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Enable Language Identification',
				name: 'enableLanguageIdentification',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Enable Speaker Diarization',
				name: 'enableSpeakerDiarization',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Context Mode',
				name: 'contextMode',
				type: 'options',
				default: 'text',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
				options: [
					{
						name: 'Text',
						value: 'text',
					},
					{
						name: 'Structured JSON',
						value: 'structured',
					},
				],
			},
			{
				displayName: 'Context Text',
				name: 'contextText',
				type: 'string',
				default: '',
				typeOptions: {
					rows: 4,
				},
				description: 'Free-form context text to improve transcription',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						contextMode: ['text'],
					},
				},
			},
			{
				displayName: 'Context JSON',
				name: 'contextJson',
				type: 'json',
				default: '{\n  "general": [{"key": "", "value": ""}],\n  "text": "",\n  "terms": [],\n  "translation_terms": [{"source": "", "target": ""}]\n}',
				description: 'Structured context JSON payload',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						contextMode: ['structured'],
					},
				},
			},
			{
				displayName: 'Client Reference ID',
				name: 'clientReferenceId',
				type: 'string',
				default: '',
				description: 'Custom reference ID for your tracking',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Webhook URL',
				name: 'webhookUrl',
				type: 'string',
				default: '',
				placeholder: 'https://example.com/soniox/webhook',
				description: 'Optional webhook URL for Soniox callbacks',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Webhook Auth Header Name',
				name: 'webhookAuthHeaderName',
				type: 'string',
				default: '',
				description: 'Header name for webhook authentication',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Webhook Auth Header Value',
				name: 'webhookAuthHeaderValue',
				type: 'string',
				default: '',
				typeOptions: {
					password: true,
				},
				description: 'Header value for webhook authentication',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				description: 'Whether to wait for the transcription to complete and return the transcript',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Poll Interval (Sec)',
				name: 'pollIntervalSec',
				type: 'number',
				default: 1,
				typeOptions: {
					minValue: 1,
				},
				description: 'Delay between polling requests in seconds',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						waitForCompletion: [true],
					},
				},
			},
			{
				displayName: 'Max Wait (Sec)',
				name: 'maxWaitSec',
				type: 'number',
				default: 300,
				typeOptions: {
					minValue: 1,
				},
				description: 'Maximum time to wait for completion in seconds',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						waitForCompletion: [true],
					},
				},
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				default: 'full',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						waitForCompletion: [true],
					},
				},
				options: [
					{
						name: 'Full Response',
						value: 'full',
						description: 'Return full transcript with all metadata',
					},
					{
						name: 'Text Only',
						value: 'textOnly',
						description: 'Return only the transcribed text',
					},
				],
			},
			{
				displayName: 'Translation Type',
				name: 'translationType',
				type: 'options',
				default: 'none',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
					},
				},
				options: [
					{
						name: 'None',
						value: 'none',
					},
					{
						name: 'One Way',
						value: 'one_way',
					},
					{
						name: 'Two Way',
						value: 'two_way',
					},
				],
			},
			{
				displayName: 'Target Language',
				name: 'targetLanguage',
				type: 'string',
				default: '',
				description: 'Target language for one-way translation',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						translationType: ['one_way'],
					},
				},
			},
			{
				displayName: 'Language A',
				name: 'languageA',
				type: 'string',
				default: '',
				description: 'First language for two-way translation',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						translationType: ['two_way'],
					},
				},
			},
			{
				displayName: 'Language B',
				name: 'languageB',
				type: 'string',
				default: '',
				description: 'Second language for two-way translation',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						translationType: ['two_way'],
					},
				},
			},
			{
				displayName: 'Auto Delete',
				name: 'autoDelete',
				type: 'boolean',
				default: true,
				description: 'Whether to automatically delete the transcription (and uploaded file if applicable) after completion',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['create'],
						waitForCompletion: [true],
					},
				},
			},
			{
				displayName: 'Transcription ID',
				name: 'transcriptionId',
				type: 'string',
				default: '',
				required: true,
				description: 'ID of the transcription job',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['getResults'],
					},
				},
			},
			// Delete operation properties
			{
				displayName: 'Transcription ID',
				name: 'deleteTranscriptionId',
				type: 'string',
				default: '',
				required: true,
				description: 'ID of the transcription to delete (will also delete the associated file if one exists)',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['delete'],
					},
				},
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['getResults'],
					},
				},
			},
			{
				displayName: 'Poll Interval (Sec)',
				name: 'pollIntervalSec',
				type: 'number',
				default: 1,
				typeOptions: {
					minValue: 1,
				},
				description: 'Delay between polling requests in seconds',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['getResults'],
						waitForCompletion: [true],
					},
				},
			},
			{
				displayName: 'Max Wait (Sec)',
				name: 'maxWaitSec',
				type: 'number',
				default: 180,
				typeOptions: {
					minValue: 1,
				},
				description: 'Maximum time to wait for completion in seconds',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['getResults'],
						waitForCompletion: [true],
					},
				},
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				default: 'full',
				description: 'What to return when transcription is complete',
				displayOptions: {
					show: {
						resource: ['transcription'],
						operation: ['getResults'],
					},
				},
				options: [
					{
						name: 'Full Response',
						value: 'full',
						description: 'Return full transcript with all metadata',
					},
					{
						name: 'Text Only',
						value: 'textOnly',
						description: 'Return only the transcribed text',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				if (resource !== 'transcription') {
					throw new NodeOperationError(this.getNode(), `Unsupported resource: ${resource}`);
				}

				if (operation === 'create') {
					const audioSource = this.getNodeParameter('audioSource', itemIndex) as string;
					const model = this.getNodeParameter('model', itemIndex) as string;

					if (!isNonEmptyString(model)) {
						throw new NodeOperationError(this.getNode(), 'Model is required', {
							description: 'Specify a Soniox model ID (e.g., "stt-async-v3"). Check Soniox documentation for available models.',
						});
					}

					let audioUrl: string | undefined;
					let fileId: string | undefined;

				if (audioSource === 'binary') {
					const binaryPropertyName = this.getNodeParameter(
						'binaryPropertyName',
						itemIndex,
					) as string;
					fileId = await uploadFile.call(this, itemIndex, binaryPropertyName);
				} else if (audioSource === 'url') {
						const rawAudioUrl = this.getNodeParameter('audioUrl', itemIndex) as string;
						if (!isNonEmptyString(rawAudioUrl)) {
							throw new NodeOperationError(this.getNode(), 'Audio URL is required', {
								description: 'Provide a publicly accessible URL to your audio file (e.g., https://example.com/audio.wav).',
							});
						}
						audioUrl = rawAudioUrl;
					} else if (audioSource === 'fileId') {
						const rawFileId = this.getNodeParameter('fileId', itemIndex) as string;
						if (!isNonEmptyString(rawFileId)) {
							throw new NodeOperationError(this.getNode(), 'File ID is required', {
								description: 'Provide the ID of a file previously uploaded to Soniox.',
							});
						}
						fileId = rawFileId;
					} else {
						throw new NodeOperationError(this.getNode(), `Unsupported audio source: ${audioSource}`, {
							description: 'Select a valid audio source: Binary File, Audio URL, or File ID.',
						});
					}

					if ((audioUrl && fileId) || (!audioUrl && !fileId)) {
						throw new NodeOperationError(
							this.getNode(),
							'Provide exactly one audio source (audio URL or file ID)',
							{
								description: 'Select one audio source type and provide the required value.',
							},
						);
					}

				const languageHintsInput = this.getNodeParameter(
					'languageHints',
					itemIndex,
					{},
				) as IDataObject;
				const languageHints = normalizeLanguageHints(languageHintsInput);

					const languageHintsStrict = this.getNodeParameter(
						'languageHintsStrict',
						itemIndex,
						false,
					) as boolean;
					const enableLanguageIdentification = this.getNodeParameter(
						'enableLanguageIdentification',
						itemIndex,
						false,
					) as boolean;
					const enableSpeakerDiarization = this.getNodeParameter(
						'enableSpeakerDiarization',
						itemIndex,
						false,
					) as boolean;

					const contextMode = this.getNodeParameter('contextMode', itemIndex) as string;
					let context: IDataObject | string | undefined;
					if (contextMode === 'text') {
						const contextText = this.getNodeParameter('contextText', itemIndex, '') as string;
						if (isNonEmptyString(contextText)) {
							context = contextText;
						}
					} else if (contextMode === 'structured') {
						const contextJson = this.getNodeParameter('contextJson', itemIndex, {});
						try {
							context = parseStructuredContext(contextJson);
						} catch (e) {
							const message = e instanceof Error ? e.message : 'Invalid JSON';
							throw new NodeOperationError(this.getNode(), `Invalid context: ${message}`, {
								description: 'Check that your context JSON is valid. The API expects an object with optional fields: general, text, terms, translation_terms.',
							});
						}
					}

					const clientReferenceId = this.getNodeParameter(
						'clientReferenceId',
						itemIndex,
						'',
					) as string;
					const webhookUrl = this.getNodeParameter('webhookUrl', itemIndex, '') as string;
					const webhookAuthHeaderName = this.getNodeParameter(
						'webhookAuthHeaderName',
						itemIndex,
						'',
					) as string;
					const webhookAuthHeaderValue = this.getNodeParameter(
						'webhookAuthHeaderValue',
						itemIndex,
						'',
					) as string;

					const translationType = this.getNodeParameter(
						'translationType',
						itemIndex,
						'none',
					) as string;

					const body: IDataObject = {
						model,
					};

					if (audioUrl) {
						body.audio_url = audioUrl;
					}

					if (fileId) {
						body.file_id = fileId;
					}

					if (languageHints.length) {
						body.language_hints = languageHints;
					}

					if (languageHintsStrict) {
						body.language_hints_strict = true;
					}

					if (enableLanguageIdentification) {
						body.enable_language_identification = true;
					}

					if (enableSpeakerDiarization) {
						body.enable_speaker_diarization = true;
					}

					if (typeof context === 'string') {
						if (isNonEmptyString(context)) {
							body.context = context;
						}
					} else if (context && typeof context === 'object' && Object.keys(context).length > 0) {
						body.context = context;
					}

					if (isNonEmptyString(clientReferenceId)) {
						body.client_reference_id = clientReferenceId;
					}

					if (isNonEmptyString(webhookUrl)) {
						body.webhook_url = webhookUrl;
					}

					if (isNonEmptyString(webhookAuthHeaderName)) {
						body.webhook_auth_header_name = webhookAuthHeaderName;
					}

					if (isNonEmptyString(webhookAuthHeaderValue)) {
						body.webhook_auth_header_value = webhookAuthHeaderValue;
					}

					if (translationType === 'one_way') {
						const targetLanguage = this.getNodeParameter(
							'targetLanguage',
							itemIndex,
							'',
						) as string;
						if (!isNonEmptyString(targetLanguage)) {
							throw new NodeOperationError(
								this.getNode(),
								'Target language is required for one-way translation',
								{
									description: 'Specify the language code to translate to (e.g., "en", "es", "fr").',
								},
							);
						}
						body.translation = {
							type: 'one_way',
							target_language: targetLanguage,
						};
					} else if (translationType === 'two_way') {
						const languageA = this.getNodeParameter('languageA', itemIndex, '') as string;
						const languageB = this.getNodeParameter('languageB', itemIndex, '') as string;
						if (!isNonEmptyString(languageA) || !isNonEmptyString(languageB)) {
							throw new NodeOperationError(
								this.getNode(),
								'Language A and Language B are required for two-way translation',
								{
									description: 'Specify both language codes for bidirectional translation (e.g., "en" and "es").',
								},
							);
						}
						body.translation = {
							type: 'two_way',
							language_a: languageA,
							language_b: languageB,
						};
					}

		

				const response = (await sonioxApiRequest.call(this, {
					method: 'POST',
					url: '/v1/transcriptions',
					body,
				})) as IDataObject;

				const waitForCompletion = this.getNodeParameter(
					'waitForCompletion',
					itemIndex,
					true,
				) as boolean;

				if (!waitForCompletion) {
					returnData.push({
						json: redactWebhookAuthHeaderValue(response),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const transcriptionId = response.id as string;
				if (!transcriptionId) {
					throw new NodeOperationError(
						this.getNode(),
						'Transcription creation did not return an ID',
						{
							description: 'The Soniox API response was unexpected. Please try again or contact Soniox support.',
						},
					);
				}

			const pollIntervalSec = this.getNodeParameter(
				'pollIntervalSec',
				itemIndex,
				1,
			) as number;
			const maxWaitSec = this.getNodeParameter('maxWaitSec', itemIndex, 300) as number;
			const outputMode = this.getNodeParameter('outputMode', itemIndex, 'full') as string;
			const autoDelete = this.getNodeParameter('autoDelete', itemIndex, true) as boolean;

			let result: TranscriptResult | undefined;
			let pollError: Error | undefined;

			try {
				result = await pollForCompletion.call(this, {
					transcriptionId,
					pollIntervalSec,
					maxWaitSec,
				});
			} catch (error) {
				pollError = error as Error;
			}

			// Auto-delete if enabled (always, even on failure - best effort cleanup)
			let deleteWarnings: string[] = [];
			if (autoDelete) {
				const fileIdToDelete = audioSource === 'binary' ? fileId : undefined;
				const deleteResult = await deleteResources.call(this, transcriptionId, fileIdToDelete);
				deleteWarnings = deleteResult.warnings;
			}

			// Re-throw the original error after cleanup
			if (pollError) {
				throw pollError;
			}

			const output =
					outputMode === 'textOnly'
						? { text: result!.transcript?.text ?? '' }
						: redactWebhookAuthHeaderValue(result!.transcript);

				const jsonOutput: IDataObject = output as IDataObject;
				if (deleteWarnings.length > 0) {
					jsonOutput._deleteWarnings = deleteWarnings;
				}

				returnData.push({
					json: jsonOutput,
					pairedItem: { item: itemIndex },
				});
			} else if (operation === 'delete') {
				const deleteTranscriptionId = this.getNodeParameter(
					'deleteTranscriptionId',
					itemIndex,
					'',
				) as string;

				if (!isNonEmptyString(deleteTranscriptionId)) {
					throw new NodeOperationError(
						this.getNode(),
						'Transcription ID is required',
						{
							description: 'Provide the ID of the transcription you want to delete.',
						},
					);
				}

				// Fetch transcription to get the file_id
				let fileIdToDelete: string | undefined;
				try {
					const transcriptionDetails = (await sonioxApiRequest.call(this, {
						method: 'GET',
						url: `/v1/transcriptions/${deleteTranscriptionId}`,
					})) as IDataObject;
					fileIdToDelete = transcriptionDetails?.file_id as string | undefined;
				} catch {
					// If we can't fetch the transcription, still try to delete it
					fileIdToDelete = undefined;
				}

				const deleteResult = await deleteResources.call(
					this,
					deleteTranscriptionId,
					isNonEmptyString(fileIdToDelete) ? fileIdToDelete : undefined,
				);

				returnData.push({
					json: {
						success: deleteResult.warnings.length === 0,
						deleted: deleteResult.deleted,
						warnings: deleteResult.warnings.length > 0 ? deleteResult.warnings : undefined,
					},
					pairedItem: { item: itemIndex },
				});
			} else if (operation === 'getResults') {
					const transcriptionId = this.getNodeParameter(
						'transcriptionId',
						itemIndex,
						'',
					) as string;
					if (!isNonEmptyString(transcriptionId)) {
						throw new NodeOperationError(this.getNode(), 'Transcription ID is required', {
							description: 'Provide the transcription ID returned when creating a transcription, or from a webhook callback.',
						});
					}

					const waitForCompletion = this.getNodeParameter(
						'waitForCompletion',
						itemIndex,
						false,
					) as boolean;

					const outputMode = this.getNodeParameter('outputMode', itemIndex, 'full') as string;

					if (!waitForCompletion) {
						// Check status first
						const statusResponse = (await sonioxApiRequest.call(this, {
							method: 'GET',
							url: `/v1/transcriptions/${transcriptionId}`,
						})) as IDataObject;

						const status = statusResponse?.status as string | undefined;

						// If already completed, fetch the transcript too
						if (status === STATUS_COMPLETED) {
							const transcript = (await sonioxApiRequest.call(this, {
								method: 'GET',
								url: `/v1/transcriptions/${transcriptionId}/transcript`,
							})) as IDataObject;

							const output =
								outputMode === 'textOnly'
									? { text: transcript?.text ?? '' }
									: redactWebhookAuthHeaderValue(transcript);

							returnData.push({
								json: output,
								pairedItem: { item: itemIndex },
							});
							continue;
						}

						// If error, throw
						if (status === STATUS_ERROR) {
							const errorMessage = statusResponse?.error_message
								? `: ${statusResponse.error_message}`
								: '';
							throw new NodeOperationError(
								this.getNode(),
								`Transcription failed with status "${STATUS_ERROR}"${errorMessage}`,
								{
									description: 'The transcription could not be completed. Check that the audio file was valid and in a supported format.',
								},
							);
						}

						// Otherwise return status (still processing)
						returnData.push({
							json: redactWebhookAuthHeaderValue(statusResponse),
							pairedItem: { item: itemIndex },
						});
						continue;
					}

					const pollIntervalSec = this.getNodeParameter(
						'pollIntervalSec',
						itemIndex,
						1,
					) as number;
					const maxWaitSec = this.getNodeParameter('maxWaitSec', itemIndex, 180) as number;

					const result = await pollForCompletion.call(this, {
						transcriptionId,
						pollIntervalSec,
						maxWaitSec,
					});

					const output =
						outputMode === 'textOnly'
							? { text: result.transcript?.text ?? '' }
							: redactWebhookAuthHeaderValue(result.transcript);

					returnData.push({
						json: output,
						pairedItem: { item: itemIndex },
					});
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation: ${operation}`);
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: items[itemIndex].json,
						error,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (error instanceof NodeOperationError) {
					throw error;
				}

				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex,
				});
			}
		}

		return [returnData];
	}
}

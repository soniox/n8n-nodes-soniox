# @soniox/n8n-nodes-soniox

This is an n8n community node for [Soniox](https://soniox.com), providing speech-to-text transcription capabilities in your n8n workflows.

Soniox offers state-of-the-art speech recognition with support for multiple languages, speaker diarization, and real-time transcription.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

**Quick install:**
1. Go to **Settings** > **Community Nodes**
2. Click **Install a community node**
3. Enter `@soniox/n8n-nodes-soniox`
4. Click **Install**

## Operations

### Transcription

- **Create** - Create a new transcription job from an audio file
  - Supports binary file upload, audio URL, or previously uploaded file ID
  - Optional: Wait for completion and return results
  - Optional: Configure webhook for async notifications

- **Get Results** - Retrieve transcription results
  - Fetch status and transcript for a given transcription ID
  - Optional: Wait for completion if still processing

## Credentials

To use this node, you need a Soniox API key:

1. Sign up at [soniox.com](https://soniox.com)
2. Go to your [Soniox Console](https://console.soniox.com/)
3. Navigate to API Keys and create a new key
4. In n8n, create new credentials of type **Soniox API**
5. Enter your API key

## Features

- **Multiple audio sources**: Upload binary files, provide URLs, or use pre-uploaded file IDs
- **Language detection**: Automatic language identification or specify language hints
- **Speaker diarization**: Identify and separate different speakers
- **Translation**: One-way or two-way translation support
- **Flexible output**: Get full transcript with metadata or text-only
- **Async support**: Use webhooks for long-running transcriptions
- **Custom context**: Improve accuracy with domain-specific vocabulary

## Usage Examples

### Basic Transcription

1. Add a **Soniox** node to your workflow
2. Select **Create** operation
3. Choose your audio source (Binary File, URL, or File ID)
4. Enable **Wait for Completion** to get results immediately
5. Execute the workflow

### Webhook-Based Async Flow

1. Create a transcription with **Wait for Completion** disabled
2. Configure a **Webhook URL** pointing to an n8n Webhook trigger
3. When transcription completes, Soniox calls your webhook
4. Use a second **Soniox** node with **Get Results** to fetch the transcript

## Compatibility

- Minimum n8n version: 1.0.0
- Tested with n8n versions: 1.x, 2.x

## Resources

- [Soniox n8n Integration Guide](https://soniox.com/docs/stt/integrations/n8n)
- [Soniox Documentation](https://soniox.com/docs/)
- [Soniox API Reference](https://soniox.com/docs/stt/api-reference)
- [n8n Community Nodes Documentation](https://docs.n8n.io/integrations/#community-nodes)

## Support

- For Soniox API issues: [support@soniox.com](mailto:support@soniox.com)
- For node issues: [GitHub Issues](https://github.com/soniox/n8n-nodes-soniox/issues)

## License

[MIT](LICENSE)

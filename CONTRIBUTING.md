# Contributing

Thank you for improving Context Relay.

## Development

Requirements:

- Node.js 20 or later
- Git

Run the complete local gate:

```bash
npm run check
```

Keep the plugin dependency-free unless a dependency provides a clear security or correctness benefit that cannot be implemented safely with the standard library.

## Pull requests

- Add or update tests for behavior changes.
- Use only synthetic examples.
- Do not commit private conversation exports, internal paths, account identifiers, credentials, or customer data.
- Preserve the distinction between verified, unverified, planned, unknown, superseded, and stale states.
- Describe what was tested and what remains unverified.

## Useful contributions

- Reproduction cases where a stale handoff is accepted.
- Secret or PII patterns that the validator misses, supplied with synthetic values.
- Adapters that preserve the open handoff protocol without uploading private transcripts.
- Evaluation cases that measure whether a fresh agent takes the correct first action.

Please discuss new remote services or automatic task-management features before implementation. They change the privacy and authorization model.

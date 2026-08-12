# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue containing credentials, private repository content, personal data, or a working exploit against another user's system.

Use GitHub private vulnerability reporting for this repository. Include the affected version, reproduction steps using synthetic data, impact, and a suggested mitigation when available.

## Data handling

Context Relay is designed to run locally and has no built-in network client, telemetry, remote storage, or MCP server. It can still include sensitive data if a model copies that data from visible context or project files.

Before publishing a handoff:

1. Review the generated Markdown and JSON.
2. Run the validator and privacy scan.
3. Remove company names, internal paths, private URLs, identifiers, and customer data before public disclosure.
4. Rotate any credential that was exposed before the scan.

Automated scanning cannot prove that a document is safe to disclose.

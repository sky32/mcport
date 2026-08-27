<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/MCPort-Logo-Dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/MCPort-Logo-Light.png">
    <img src="resources/MCPort-Logo-Light.png" alt="MCPort" width="360">
  </picture>
</p>

<p align="center">Safely connect local projects to MCP-compatible AI clients.</p>

# MCPort

MCPort is a local-first MCP tool for working with projects through AI. It lets an AI client read code, search files, understand symbols, inspect Git, edit files, and—when explicitly authorized—run controlled development commands inside selected Workspaces.

Project files, runtime state, and credentials stay on your machine by default. You can use MCP locally or enable OAuth/Bearer Token access for selected Workspaces over the public internet.

中文说明：[README.zh-CN.md](README.zh-CN.md)

## Features

- Read and search project files, source code, images, and directories
- Code indexing plus definition, reference, Hover, and document-symbol support
- Git status, diffs, history, and blame
- Contained file creation, editing, import, copy, move, and deletion
- Checkpoints, tasks, validation, and recovery for file changes
- Controlled command execution with allowlists, timeouts, output limits, and local confirmation
- Local or public MCP access for one or more Workspaces
- Per-language LSP installation and updates, with custom server support

## Connect an AI client

In MCPort, add a project under **Projects**, enable MCP for the Workspace, then copy its connection information. Add the copied MCP address to your AI client’s MCP settings. For public access, use the Workspace public address and its configured OAuth or Bearer Token authentication.

Common clients that support MCP include Claude Desktop, Cursor, Windsurf, Cline, Continue, and other MCP-compatible clients. Their settings locations and configuration formats vary; follow the client’s current MCP documentation and paste the address or configuration supplied by MCPort.

After installing or updating an LSP, ask the AI client to call `server_info` again so it can refresh the available language capabilities.

## Connections

Local access accepts loopback requests by default. Public access can use Cloudflare Tunnel, TryCloudflare, FRP Client, or an external tunnel, with OAuth (recommended) or Bearer Token authentication.

Public Workspaces use routes like:

```text
https://mcp.example.com/w/<workspace>/mcp
```

## Files, code, and LSP

File operations remain inside the selected Workspace after realpath and symlink checks. The built-in code index supports TypeScript, TSX, JavaScript, JSX, MJS, and CJS.

Language servers are managed independently and can be installed or updated on demand. Supported languages include TypeScript/JavaScript, HTML, CSS/SCSS/LESS, Python, JSON, YAML, Markdown, Go, Rust, Java, C, C++, and PHP. Custom LSP definitions can be added for other languages.

## Permission tiers

- `readonly`: project browsing, search, code understanding, read-only Git, and history
- `standard`: file changes, imports, checkpoints, tasks, and quick validation
- `full`: controlled commands, command sessions, recovery, and complete validation

Commands use an executable name plus an argument array, never an arbitrary shell string. They remain subject to the global command switch, exact allowlist, timeouts, output limits, and high-risk confirmation.

## Security

Workspace boundaries are checked after resolving real paths and symlinks. File changes support SHA256 baselines, transactional rollback, and checkpoints. Public Workspaces always require authentication. Tokens, tunnel credentials, and other secrets use system secure storage and are redacted from logs and traces.

The Runtime runs as the logged-in OS user. The command allowlist is not an operating-system sandbox.

## Documentation

- [Desktop guide](docs/desktop-app.md)
- [AI client guide](docs/ai-usage.md)
- [MCP tools](docs/tools.md)
- [LSP guide](docs/lsp.md)
- [Security](docs/security.md)
- [Public gateway and OAuth](docs/architecture/public-gateway-and-oauth.md)
- [Tools and permissions](docs/architecture/tools-and-execution.md)
- [Release guide](docs/releasing.md)

## Contributing

MCPort is maintained by Sky and released under the MIT License. Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [privacy notes](docs/privacy.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

Third-party LSPs are installed from their own official package managers or release channels and are not bundled with MCPort. Follow each project’s license and terms.

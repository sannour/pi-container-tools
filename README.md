# pi-container-tools

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for downloading and installing CLI tools inside containers — without touching the root filesystem.

## Why?

When running pi inside a container image, you often need CLI tools that aren't pre-installed. This extension lets the LLM download and install tools into `/workspace/.pi/tools/` (a persisted volume), keeping the container rootfs clean.

## Features

- **`install_tool`** — custom pi tool that downloads a binary from a URL into `/workspace/.pi/tools/bin/`
- **Package manager interceptor** — automatically redirects `apt install`, `pip install`, `npm i -g`, `apk add`, `dnf install`, and `pacman -S` away from rootfs
- **PATH injection** — all bash commands get `/workspace/.pi/tools/bin/` and other install paths prepended to `$PATH`
- **`/tools` command** — shows what's installed

## Install

```bash
pi install git:github.com/user/pi-container-tools
```

Or locally:

```bash
cp -r extensions/container-tools .pi/extensions/
```

## Usage

Once installed, the extension is active. The LLM can:

```typescript
// Download a CLI tool
install_tool({
  url: "https://github.com/cli/cli/releases/download/v2.49.0/gh_2.49.0_linux_amd64.tar.gz",
  name: "gh",
  extract: true,
  checksum: "abc123..."
})
```

The tool is immediately available in subsequent bash commands via PATH injection.

Package managers are transparently redirected — when the LLM runs `apt install jq`, it gets redirected to:

```bash
mkdir -p /workspace/.pi/tools/apt/var/lib/dpkg ... && \
apt-get update -o Dir=/workspace/.pi/tools/apt ... && \
apt-get install -y -o Dir=/workspace/.pi/tools/apt ... jq
```

## Directory Layout

```
/workspace/.pi/tools/
├── bin/          # Directly downloaded binaries
├── apt/          # apt/apk/dnf/pacman packages
├── pip-packages/ # Python packages
└── npm/          # Global npm packages
```

## Supported Package Managers

| Command | Redirected install location |
|---------|---------------------------|
| `apt install` | `/workspace/.pi/tools/apt/` |
| `apk add` | `/workspace/.pi/tools/apt/` |
| `pip install` | `/workspace/.pi/tools/pip-packages/` |
| `npm i -g` | `/workspace/.pi/tools/npm/` |
| `dnf install` | `/workspace/.pi/tools/apt/` |
| `yum install` | `/workspace/.pi/tools/apt/` |
| `pacman -S` | `/workspace/.pi/tools/apt/` |

## License

MIT

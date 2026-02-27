# ai-commit

Generate a commit message from staged git diff with AI, then choose to:

- commit directly
- edit in your terminal editor
- regenerate
- quit

## Features

- Conventional commit style one-line suggestion
- Interactive TUI menu (`Commit / Edit / Regenerate / Quit`)
- Editor-based message editing (`$EDITOR`)
- Quick mode: `--yes`
- Editor-first mode: `--edit`

## Requirements

- Node.js 18+
- Git
- API key and model for your LLM provider (OpenAI-compatible API)

## Install

```bash
npm install
```

## Environment Variables

Create `.env` (or export in shell):

```bash
export GIT_LLM_API_KEY="..."
export GIT_LLM_BASE_URL="https://api.openai.com/v1"
export GIT_LLM_MODEL="gpt-4o-mini"
```

If `GIT_LLM_BASE_URL` is not needed, leave it empty or unset.

## Usage

1. Stage your changes:

```bash
git add <files>
```

2. Run:

```bash
node generate-commit.js
```

### Optional modes

```bash
node generate-commit.js --yes
node generate-commit.js --edit
```

## Git Alias

```bash
git config --global alias.ai-commit '!node ~/scripts/ai-commit/generate-commit.js'
```

Then use:

```bash
git ai-commit
git ai-commit --yes
git ai-commit --edit
```

## Menu Keys

- `↑/↓` or `j/k`: move selection
- `Enter`: confirm
- `c/e/r/q`: quick action

## Troubleshooting

- `No staged files`: run `git add` first.
- `Missing env`: make sure `GIT_LLM_API_KEY` and `GIT_LLM_MODEL` are set.
- If editor opens as `vi`, set your preferred editor:

```bash
export EDITOR="code -w"
```

## Security Notes

- Only staged diff (`git diff --cached`) is sent to your model API.
- Diff is truncated to protect token usage.

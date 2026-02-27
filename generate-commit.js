import OpenAI from "openai";
import { execSync, spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import readline from "readline";
import fs from "fs";
import os from "os";
import path from "path";

const client = new OpenAI({
  apiKey: process.env.GIT_LLM_API_KEY,
  baseURL: process.env.GIT_LLM_BASE_URL, // 关键：换成你的供应商地址
});


function getStagedFiles() {
  return execSync("git diff --cached --name-only", {
    encoding: "utf-8",
  }).trim();
}

function getStagedDiff() {
  return execSync("git diff --cached", {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024, // 防止大 diff 崩溃
  }).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    yes: args.includes("--yes") || args.includes("-y"),
    edit: args.includes("--edit"),
  };
}

function ensureEnv() {
  const missing = [];
  if (!process.env.GIT_LLM_API_KEY) missing.push("GIT_LLM_API_KEY");
  if (!process.env.GIT_LLM_MODEL) missing.push("GIT_LLM_MODEL");
  if (missing.length > 0) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
}

function trimQuotes(message) {
  return message.trim().replace(/^["'`]/, "").replace(/["'`]$/, "");
}

function gitCommitWithMessage(message) {
  const result = spawnSync("git", ["commit", "-m", message], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function gitCommitViaEditor(initialMessage) {
  const editor = process.env.EDITOR || "vi";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-commit-"));
  const tempFile = path.join(tempDir, "COMMIT_EDITMSG");
  fs.writeFileSync(tempFile, `${initialMessage}\n`, "utf-8");

  const editCmd = `${editor} ${shellEscape(tempFile)}`;
  const editResult = spawnSync("sh", ["-c", editCmd], { stdio: "inherit" });
  if (editResult.status !== 0) process.exit(editResult.status ?? 1);

  const commitResult = spawnSync("git", ["commit", "-F", tempFile], { stdio: "inherit" });
  if (commitResult.status !== 0) process.exit(commitResult.status ?? 1);
}

function editMessageInEditor(initialMessage) {
  const editor = process.env.EDITOR || "vi";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-commit-edit-"));
  const tempFile = path.join(tempDir, "MESSAGE.txt");
  fs.writeFileSync(
    tempFile,
    `${initialMessage}\n\n# Edit commit title above and save.\n# Only the first non-comment line will be used.\n`,
    "utf-8",
  );

  const editCmd = `${editor} ${shellEscape(tempFile)}`;
  const editResult = spawnSync("sh", ["-c", editCmd], { stdio: "inherit" });
  if (editResult.status !== 0) return null;

  const content = fs.readFileSync(tempFile, "utf-8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines[0] || initialMessage;
}

async function fallbackChoose() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question("[c]ommit / [e]dit / [r]egenerate / [q]uit: ")
  ).trim().toLowerCase();
  rl.close();
  if (answer === "c" || answer === "commit") return "Commit";
  if (answer === "e" || answer === "edit") return "Edit";
  if (answer === "r" || answer === "regenerate") return "Regenerate";
  return "Quit";
}

async function fallbackEdit(defaultValue) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Commit message [${defaultValue}]: `)).trim();
  rl.close();
  return answer || defaultValue;
}

function clearLines(count) {
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[1A");
    process.stdout.write("\x1b[2K");
  }
}

function printMenu(selected) {
  const items = ["Commit", "Edit", "Regenerate", "Quit"];
  process.stdout.write("\x1b[2K");
  process.stdout.write("Use ↑/↓, j/k, Enter. Quick keys: c/e/r/q\n");
  for (let i = 0; i < items.length; i++) {
    const prefix = i === selected ? "›" : " ";
    const style = i === selected ? "\x1b[36m" : "\x1b[90m";
    process.stdout.write(`\x1b[2K${style}${prefix} ${items[i]}\x1b[0m\n`);
  }
}

function promptMenuTUI() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }

    const items = ["Commit", "Edit", "Regenerate", "Quit"];
    let index = 0;
    let renderedLines = 5;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    printMenu(index);

    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.off("keypress", onKeypress);
      clearLines(renderedLines);
      resolve(value);
    };

    const redraw = () => {
      clearLines(renderedLines);
      printMenu(index);
    };

    const onKeypress = (_, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        done("Quit");
        return;
      }
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + items.length) % items.length;
        redraw();
        return;
      }
      if (key.name === "down" || key.name === "j") {
        index = (index + 1) % items.length;
        redraw();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        done(items[index]);
        return;
      }
      const quickKey = key.sequence?.toLowerCase();
      if (quickKey === "c") done("Commit");
      if (quickKey === "e") done("Edit");
      if (quickKey === "r") done("Regenerate");
      if (quickKey === "q") done("Quit");
    };

    process.stdin.on("keypress", onKeypress);
  });
}

async function generateMessage(diff) {
  const MAX_CHARS = 12000;
  const safeDiff =
    diff.length > MAX_CHARS
      ? diff.slice(0, MAX_CHARS) + "\n\n... (truncated)"
      : diff;

  const response = await client.chat.completions.create({
    model: process.env.GIT_LLM_MODEL,
    messages: [
      {
        role: "system",
        content: `
You write concise conventional commit messages.

Rules:
- One line only
- Max 72 characters
- No quotes
- No explanation
- No code block
        `,
      },
      {
        role: "user",
        content: safeDiff,
      },
    ],
  });

  return trimQuotes(response.choices[0].message.content || "");
}

async function main() {
  try {
    ensureEnv();
    const args = parseArgs();

    // 1️⃣ 检查是否有 staged 文件
    const stagedFiles = getStagedFiles();
    if (!stagedFiles) {
      console.log("❌ No staged files. Run: git add <files>");
      process.exit(0);
    }

    // 2️⃣ 获取 diff
    const diff = getStagedDiff();
    if (!diff) {
      console.log("❌ Staged files have no diff.");
      process.exit(0);
    }

    console.log("🤖 Generating commit message...\n");
    let message = await generateMessage(diff);
    if (!message) {
      throw new Error("Model returned empty commit message");
    }

    // 快速提交模式（无交互）
    if (args.yes) {
      console.log(`✅ Commit message:\n${message}\n`);
      gitCommitWithMessage(message);
      return;
    }

    // 编辑器模式：打开 $EDITOR，保存后直接 commit
    if (args.edit) {
      console.log(`✅ Initial commit message:\n${message}\n`);
      gitCommitViaEditor(message);
      return;
    }

    while (true) {
      console.log("✅ Suggested commit message:\n");
      console.log(message);
      console.log("");

      const action = (await promptMenuTUI()) || await fallbackChoose();

      if (!action || action === "Quit") {
        console.log("👋 Exit without committing.");
        process.exit(0);
      }

      if (action === "Commit") {
        gitCommitWithMessage(message);
        return;
      }

      if (action === "Edit") {
        const edited = process.stdin.isTTY
          ? editMessageInEditor(message) || message
          : await fallbackEdit(message);
        if (edited && edited.trim()) message = edited.trim();
        continue;
      }

      if (action === "Regenerate") {
        console.log("🤖 Regenerating commit message...\n");
        message = await generateMessage(diff);
        if (!message) {
          throw new Error("Model returned empty commit message");
        }
      }
    }
  } catch (err) {
    console.error("🚨 Failed to generate commit message:");
    console.error(err.message);
    process.exit(1);
  }
}

main();

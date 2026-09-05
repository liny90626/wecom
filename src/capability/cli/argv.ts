import {
  CLI_FORBIDDEN_AUTH_ACTIONS,
  CLI_FORBIDDEN_SUBCOMMANDS,
  CLI_SHELL_METACHARS,
  CLI_SUBCOMMAND_RE,
} from "./const.js";

export class CliArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgvError";
  }
}

/** Small quote-aware tokenizer used only for string compatibility input. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let hasToken = false;
  let index = 0;

  while (index < input.length) {
    const ch = input[index];
    if (ch === " " || ch === "\t") {
      if (hasToken) {
        out.push(current);
        current = "";
        hasToken = false;
      }
      index += 1;
      continue;
    }

    if (ch === "'") {
      hasToken = true;
      index += 1;
      const end = input.indexOf("'", index);
      if (end < 0) throw new CliArgvError("args 中单引号未闭合");
      current += input.slice(index, end);
      index = end + 1;
      continue;
    }

    if (ch === '"') {
      hasToken = true;
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === "\\" && index + 1 < input.length) {
          const next = input[index + 1];
          current += next === '"' || next === "\\" ? next : `\\${next}`;
          index += 2;
        } else {
          current += input[index];
          index += 1;
        }
      }
      if (index >= input.length) throw new CliArgvError("args 中双引号未闭合");
      index += 1;
      continue;
    }

    if (ch === "\\" && index + 1 < input.length) {
      hasToken = true;
      current += input[index + 1];
      index += 2;
      continue;
    }

    if (CLI_SHELL_METACHARS.test(ch)) {
      throw new CliArgvError(
        `args 中包含未被引号包裹的 shell 组合符 ${JSON.stringify(ch)}。` +
          "本 tool 直接执行 wecom-cli，不经过 shell，因此不支持管道、重定向与命令组合。" +
          "若该字符是参数值的一部分，请用引号包裹，或改用数组形式的 args。",
      );
    }
    if (ch === "$" && input[index + 1] === "(") {
      throw new CliArgvError(
        "args 中包含未被引号包裹的命令替换 `$(`。本 tool 不经过 shell 执行，请直接给出参数值；若该内容是参数值的一部分，请用引号包裹或改用数组形式的 args。",
      );
    }
    hasToken = true;
    current += ch;
    index += 1;
  }

  if (hasToken) out.push(current);
  return out;
}

export function assertSafeArgv(argv: string[]): void {
  if (argv.length === 0) {
    throw new CliArgvError("args 不能为空，至少需要指定品类，如 `contact users search --json '{}'`");
  }
  const head = argv[0];
  if (!CLI_SUBCOMMAND_RE.test(head)) {
    throw new CliArgvError(
      `第一个参数 ${JSON.stringify(head)} 不是合法的子命令名。应为品类名（如 contact / doc / meeting / todo / calendar）或 auth / cache。`,
    );
  }
  if (CLI_FORBIDDEN_SUBCOMMANDS.has(head)) {
    throw new CliArgvError(
      `子命令 \`${head}\` 已被禁用：它是交互式流程且会改写全局凭据存储。企业微信凭据请在 openclaw 配置 \`channels.wecom\` 中维护。`,
    );
  }
  if (head === "auth" && argv[1] && CLI_FORBIDDEN_AUTH_ACTIONS.has(argv[1])) {
    throw new CliArgvError(
      `\`auth ${argv[1]}\` 已被禁用：企业微信凭据由插件按当前会话的机器人自动管理，不需要（也不允许）手动授权。若提示凭据不可用，请检查 openclaw 配置 \`channels.wecom\` 中的 botId / secret。`,
    );
  }
  for (const token of argv) {
    if (/^WECOM_CLI_[A-Za-z0-9_]*=/.test(token)) {
      throw new CliArgvError(
        `args 中不允许出现环境变量赋值 ${JSON.stringify(token)}；运行环境由插件按当前会话的机器人注入。`,
      );
    }
    if (/^--config-dir(?:=|$)/.test(token) || /^--home(?:=|$)/.test(token)) {
      throw new CliArgvError(
        `args 中不允许覆盖配置目录（${JSON.stringify(token)}）；配置目录由插件按当前会话的机器人决定。`,
      );
    }
  }
}

export function normalizeArgs(args: unknown): string[] {
  let argv: string[];
  if (Array.isArray(args)) {
    argv = args.map((value) => {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      throw new CliArgvError(`args 数组元素必须是字符串，收到 ${typeof value}`);
    });
  } else if (typeof args === "string") {
    argv = tokenize(args);
  } else {
    throw new CliArgvError(`args 必须是字符串或字符串数组，收到 ${typeof args}`);
  }

  if (argv[0] === "wecom-cli" || argv[0] === "wecom") {
    argv = argv.slice(1);
  }
  assertSafeArgv(argv);
  return argv;
}

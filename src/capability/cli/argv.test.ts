import { describe, expect, it } from "vitest";

import { assertSafeArgv, CliArgvError, normalizeArgs, tokenize } from "./argv.js";

describe("wecom-cli argv policy", () => {
  it("splits quoted values and preserves embedded whitespace", () => {
    expect(tokenize("contact users search --json '{\"keywords\":[\"张三\"]}'")).toEqual([
      "contact",
      "users",
      "search",
      "--json",
      '{"keywords":["张三"]}',
    ]);
    expect(tokenize('doc contents get --name "a \\\"quoted\\\" file"')).toEqual([
      "doc",
      "contents",
      "get",
      "--name",
      'a "quoted" file',
    ]);
  });

  it("accepts JSON punctuation and ordinary dollar/parenthesis values", () => {
    expect(normalizeArgs(["doc", "get", "--json", '{"amount":"$10 (net)"}'])).toHaveLength(4);
    expect(tokenize("contact users search --name '张三(jackzhang22)'" ).at(-1)).toBe(
      "张三(jackzhang22)",
    );
  });

  it.each([";", "|", "&", "`", "<", ">", "\n", "\r"])(
    "rejects an unquoted shell metacharacter %j",
    (character) => {
      expect(() => normalizeArgs(`contact users search ${character} next`)).toThrow(CliArgvError);
    },
  );

  it("allows shell-looking characters when they are quoted", () => {
    expect(normalizeArgs("contact users search --name 'A|B;C'" )).toEqual([
      "contact",
      "users",
      "search",
      "--name",
      "A|B;C",
    ]);
    expect(() => normalizeArgs("contact users search $(whoami)")).toThrow(CliArgvError);
  });

  it("removes an accidental tool prefix", () => {
    expect(normalizeArgs(["wecom-cli", "contact", "users", "search"])).toEqual([
      "contact",
      "users",
      "search",
    ]);
    expect(normalizeArgs("wecom doc --help")).toEqual(["doc", "--help"]);
  });

  it("rejects forbidden interactive and credential commands", () => {
    expect(() => normalizeArgs(["init"])).toThrow("已被禁用");
    for (const action of ["init", "login", "logout", "bind", "unbind"]) {
      expect(() => normalizeArgs(["auth", action])).toThrow("已被禁用");
    }
  });

  it("rejects config overrides and environment assignments", () => {
    expect(() => normalizeArgs(["doc", "--config-dir", "/tmp/other"])).toThrow("配置目录");
    expect(() => normalizeArgs(["doc", "--home=/tmp/other"])).toThrow("配置目录");
    expect(() => normalizeArgs(["doc", "WECOM_CLI_BASE_URL=https://evil.example"])).toThrow(
      "环境变量",
    );
    expect(() => normalizeArgs(["doc", "WECOM_CLI_2=value"])).toThrow("环境变量");
  });

  it("requires a valid dynamic service name and non-empty args", () => {
    expect(() => normalizeArgs([])).toThrow("args 不能为空");
    expect(() => normalizeArgs("   ")).toThrow("args 不能为空");
    expect(() => assertSafeArgv(["bad service"])).toThrow("合法的子命令名");
    expect(() => normalizeArgs(null)).toThrow("字符串或字符串数组");
  });

  it("reports unclosed quotes instead of silently changing the command", () => {
    expect(() => tokenize("doc get --name 'unfinished")).toThrow("单引号未闭合");
    expect(() => tokenize('doc get --name "unfinished')).toThrow("双引号未闭合");
  });

  it("keeps direct array arguments literal", () => {
    expect(normalizeArgs(["doc", "get", "A;B", "x|y", "$(literal)"])).toEqual([
      "doc",
      "get",
      "A;B",
      "x|y",
      "$(literal)",
    ]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
)) as {
  bundle: {
    fileAssociations: Array<{ name: string }>;
    windows: { nsis: { installerHooks: string } };
  };
};
const hook = readFileSync(
  new URL("../src-tauri/windows/installer-hooks.nsh", import.meta.url),
  "utf8",
);
const desktopTauri = readFileSync(new URL("../../../scripts/desktop-tauri.mjs", import.meta.url), "utf8");

const macroBody = (name: string) =>
  hook.match(new RegExp(`!macro ${name}(?:[ \\t]+[^\\n]*)?\\n([\\s\\S]*?)!macroend`))?.[1] ?? "";
const pre = macroBody("NSIS_HOOK_PREUNINSTALL");
const post = macroBody("NSIS_HOOK_POSTUNINSTALL");
const postInstall = macroBody("NSIS_HOOK_POSTINSTALL");

// ---------------------------------------------------------------------------------------------
// A small interpreter for the NSIS subset the hook uses, over an in-memory registry for SHCTX.
// It runs the hook's own text, so the scenarios below exercise the real cleanup logic. Tauri's
// APP_ASSOCIATE and APP_UNASSOCIATE (FileAssociation.nsh, Tauri CLI 2.11.2) are modeled in JS.
// ---------------------------------------------------------------------------------------------

type RegKey = { name: string; values: Map<string, { name: string; data: string }> };

class Registry {
  keys = new Map<string, RegKey>();

  private norm(path: string) {
    return path.replace(/\\+$/, "").toLowerCase();
  }

  key(path: string) {
    return this.keys.get(this.norm(path));
  }

  ensure(path: string) {
    const parts = path.split("\\");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("\\");
      if (!this.keys.has(this.norm(sub))) this.keys.set(this.norm(sub), { name: sub, values: new Map() });
    }
    return this.key(path)!;
  }

  read(path: string, name: string) {
    return this.key(path)?.values.get(name.toLowerCase())?.data;
  }

  write(path: string, name: string, data: string) {
    this.ensure(path).values.set(name.toLowerCase(), { name, data });
  }

  deleteValue(path: string, name: string) {
    this.key(path)?.values.delete(name.toLowerCase());
  }

  subkeys(path: string) {
    const prefix = `${this.norm(path)}\\`;
    return [...this.keys.values()]
      .filter((key) => this.norm(key.name).startsWith(prefix) && !this.norm(key.name).slice(prefix.length).includes("\\"))
      .map((key) => key.name.slice(prefix.length));
  }

  deleteKey(path: string, ifEmpty = false) {
    const key = this.key(path);
    if (!key) return;
    if (ifEmpty && (key.values.size > 0 || this.subkeys(path).length > 0)) return;
    const prefix = `${this.norm(path)}\\`;
    for (const name of [...this.keys.keys()]) {
      if (name === this.norm(path) || name.startsWith(prefix)) this.keys.delete(name);
    }
  }
}

function tokenize(line: string) {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === " " || c === "\t") { i++; continue; }
    if (c === ";") break;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let out = "";
      while (j < line.length && line[j] !== c) {
        if (line.startsWith('$\\"', j)) { out += '$\\"'; j += 3; continue; }
        out += line[j++];
      }
      tokens.push(out);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== " " && line[j] !== "\t") j++;
    tokens.push(line.slice(i, j));
    i = j;
  }
  return tokens;
}

type Build = { productName: string; progId: string; instDir: string };

class Nsis {
  vars = new Map<string, string>();
  stack: string[] = [];
  error = false;
  notified = 0;
  macros = new Map<string, { params: string[]; body: string[] }>();

  constructor(readonly reg: Registry, readonly build: Build) {
    for (const match of hook.matchAll(/^Var\s+(\S+)/gm)) this.vars.set(match[1]!, "");
    for (const name of ["0", "1", "INSTDIR"]) this.vars.set(name, "");
    this.vars.set("INSTDIR", build.instDir);
    const macroDefs = hook.matchAll(/^!macro\s+(\S+)([^\n]*)\n([\s\S]*?)^!macroend/gm);
    for (const [, name, params, body] of macroDefs) {
      this.macros.set(name!, { params: params!.trim().split(/\s+/).filter(Boolean), body: body!.split("\n") });
    }
  }

  get uninstKey() {
    return `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${this.build.productName}`;
  }

  expand(text: string, defines: Record<string, string>) {
    let s = text.replace(/\$\{([A-Za-z_][\w]*)\}/g, (whole, name: string) => defines[name] ?? whole);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s.startsWith('$\\"', i)) { out += '"'; i += 2; continue; }
      if (s[i] === "$") {
        let end = i + 1;
        while (end < s.length && /[\w.]/.test(s[end]!)) end++;
        let matched = false;
        for (let stop = end; stop > i + 1; stop--) {
          const name = s.slice(i + 1, stop);
          if (this.vars.has(name)) { out += this.vars.get(name); i = stop - 1; matched = true; break; }
        }
        if (matched) continue;
      }
      out += s[i];
    }
    s = out;
    return s;
  }

  setVar(token: string, value: string) {
    const name = token.slice(1);
    if (!this.vars.has(name)) throw new Error(`Undeclared variable ${token}`);
    this.vars.set(name, value);
  }

  regPath(root: string, key: string) {
    if (root === "SHCTX") return key;
    if (root === "HKCR") return `Software\\Classes\\${key}`;
    throw new Error(`Unexpected registry root ${root}`);
  }

  cond(tokens: string[], defines: Record<string, string>) {
    if (tokens.length === 1 && tokens[0] === "${Errors}") return this.error;
    const [a, op, b] = tokens;
    const left = this.expand(a!, defines);
    const right = this.expand(b!, defines);
    switch (op) {
      case "==": return left.toLowerCase() === right.toLowerCase();
      case "!=": return left.toLowerCase() !== right.toLowerCase();
      case "S==": return left === right;
      case "S!=": return left !== right;
      case "=": return Number(left) === Number(right);
      case "<>": return Number(left) !== Number(right);
      default: throw new Error(`Unsupported condition ${tokens.join(" ")}`);
    }
  }

  run(macro: string, args: string[] = []) {
    const def = this.macros.get(macro);
    if (!def) {
      if (macro === "SetContext") return;
      if (macro === "UPDATEFILEASSOC") { this.notified++; return; }
      throw new Error(`Unknown macro ${macro}`);
    }
    const defines: Record<string, string> = {
      MAINBINARYNAME: "chemdraft",
      UNINSTKEY: this.uninstKey,
      ...Object.fromEntries(def.params.map((param, index) => [param, args[index] ?? ""])),
    };
    const frames: Array<{ parent: boolean; done: boolean; cur: boolean }> = [];
    const active = () => frames.every((frame) => frame.cur);
    for (const raw of def.body) {
      const tokens = tokenize(raw.trim());
      if (tokens.length === 0) continue;
      const [cmd, ...rest] = tokens;
      const frame = frames[frames.length - 1];
      switch (cmd) {
        case "${If}":
        case "${IfNot}": {
          const parent = active();
          const value = parent ? this.cond(rest, defines) : false;
          frames.push({ parent, done: false, cur: cmd === "${If}" ? value : parent && !value });
          continue;
        }
        case "${AndIf}":
          if (frame!.parent && !frame!.done) frame!.cur = frame!.cur && this.cond(rest, defines);
          continue;
        case "${OrIf}":
          if (frame!.parent && !frame!.done) frame!.cur = frame!.cur || this.cond(rest, defines);
          continue;
        case "${ElseIf}":
          frame!.done ||= frame!.cur;
          frame!.cur = frame!.parent && !frame!.done ? this.cond(rest, defines) : false;
          continue;
        case "${Else}":
          frame!.done ||= frame!.cur;
          frame!.cur = frame!.parent && !frame!.done;
          continue;
        case "${EndIf}":
          frames.pop();
          continue;
      }
      if (!active()) continue;
      const x = (index: number) => this.expand(rest[index]!, defines);
      switch (cmd) {
        case "ReadRegStr": {
          const value = this.reg.read(this.regPath(rest[1]!, x(2)), x(3));
          if (value === undefined) this.error = true;
          this.setVar(rest[0]!, value ?? "");
          break;
        }
        case "WriteRegStr":
          this.reg.write(this.regPath(rest[0]!, x(1)), x(2), x(3));
          break;
        case "DeleteRegValue":
          this.reg.deleteValue(this.regPath(rest[0]!, x(1)), x(2));
          break;
        case "DeleteRegKey": {
          const ifEmpty = rest[0] === "/ifempty";
          const args2 = ifEmpty ? rest.slice(1) : rest;
          this.reg.deleteKey(this.regPath(args2[0]!, this.expand(args2[1]!, defines)), ifEmpty);
          break;
        }
        case "EnumRegKey":
        case "EnumRegValue": {
          const path = this.regPath(rest[1]!, x(2));
          const key = this.reg.key(path);
          if (!key) { this.error = true; this.setVar(rest[0]!, ""); break; }
          const names = cmd === "EnumRegKey" ? this.reg.subkeys(path) : [...key.values.values()].map((v) => v.name);
          this.setVar(rest[0]!, names[Number(x(3))] ?? "");
          break;
        }
        case "StrCpy":
          this.setVar(rest[0]!, x(1));
          break;
        case "Push":
          this.stack.push(x(0));
          break;
        case "Pop":
          this.setVar(rest[0]!, this.stack.pop() ?? "");
          break;
        case "ClearErrors":
          this.error = false;
          break;
        case "!insertmacro":
          this.run(rest[0]!, rest.slice(1).map((_, index) => x(index + 1)));
          break;
        default:
          throw new Error(`Unsupported NSIS command: ${raw.trim()}`);
      }
    }
    expect(frames).toHaveLength(0);
  }
}

const EXT = "Software\\Classes\\.chemdraft";
const stableName = config.bundle.fileAssociations[0]!.name;
const stable: Build = { productName: "ChemDraft", progId: stableName, instDir: "C:\\Program Files\\ChemDraft" };
const dev: Build = { productName: "ChemDraft (dev)", progId: `${stableName} (dev)`, instDir: "C:\\Program Files\\ChemDraft (dev)" };

// The template's install and uninstall sections, reduced to what touches the association.
function install(reg: Registry, build: Build) {
  const backup = reg.read(EXT, "") ?? "";
  reg.write(EXT, `${build.progId}_backup`, backup);
  reg.write(EXT, "", build.progId);
  reg.write(`Software\\Classes\\${build.progId}\\shell\\open\\command`, "", `${build.instDir}\\chemdraft.exe "%1"`);
  const nsis = new Nsis(reg, build);
  reg.write(nsis.uninstKey, "DisplayName", build.productName);
  nsis.run("NSIS_HOOK_POSTINSTALL");
}

function uninstall(reg: Registry, build: Build) {
  const nsis = new Nsis(reg, build);
  nsis.run("NSIS_HOOK_PREUNINSTALL");
  reg.write(EXT, "", reg.read(EXT, `${build.progId}_backup`) ?? "");
  reg.deleteKey(`Software\\Classes\\${build.progId}`);
  reg.deleteKey(nsis.uninstKey);
  nsis.run("NSIS_HOOK_POSTUNINSTALL");
  expect(nsis.notified).toBe(1);
  expect(nsis.stack).toEqual([]);
}

const command = (reg: Registry, build: Build) => reg.read(`Software\\Classes\\${build.progId}\\shell\\open\\command`, "");
const quoted = (build: Build) => `"${build.instDir}\\chemdraft.exe" "%1"`;

describe("Windows file association quoting", () => {
  it("wires an existing installer hook", () => {
    const hookPath = config.bundle.windows.nsis.installerHooks;
    expect(hookPath).toBe("./windows/installer-hooks.nsh");
    expect(existsSync(new URL(`../src-tauri/${hookPath.slice(2)}`, import.meta.url))).toBe(true);
  });

  it("branch builds suffix the association name that the hook reads back", () => {
    expect(stableName).toBe("ChemDraft Document");
    expect(desktopTauri).toContain("name: `${association.name} (dev)`");
  });

  it("quotes the executable and document paths for this build's own registered class", () => {
    expect(postInstall).toContain('ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "Software\\Classes\\.chemdraft" ""');
    expect(postInstall).toContain('Software\\Classes\\$ChemDraftAssociationOwnProgId\\shell\\open\\command');
    expect(postInstall).toMatch(/\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\" \$\\"%1\$\\"/);
    for (const build of [stable, dev]) {
      const reg = new Registry();
      install(reg, build);
      expect(command(reg, build)).toBe(quoted(build));
      expect(reg.read(new Nsis(reg, build).uninstKey, "ChemDraftAssociationProgId")).toBe(build.progId);
    }
  });

  it("never hard-codes either build's ProgID", () => {
    expect(hook).not.toMatch(/^[^;\n]*"[^"\n]*ChemDraft Document/m);
    expect(hook).not.toMatch(/^\s*(?:ReadRegStr|WriteRegStr|DeleteRegKey|DeleteRegValue)\s+(?:\/ifempty\s+)?(?:HKCU|HKLM|HKCR)\b/m);
  });
});

describe("Windows file association uninstall cleanup", () => {
  it("restores the install scope before any SHCTX access and notifies the shell last", () => {
    expect(post.indexOf("!insertmacro SetContext")).toBeGreaterThanOrEqual(0);
    expect(post.indexOf("!insertmacro SetContext")).toBeLessThan(post.indexOf(' SHCTX "'));
    expect(post).toMatch(/!insertmacro UPDATEFILEASSOC\s*$/);
    expect(pre).toContain('ReadRegStr $ChemDraftAssociationOwnProgId SHCTX "${UNINSTKEY}" "ChemDraftAssociationProgId"');
  });

  it("never deletes the extension or OpenWithProgids key wholesale", () => {
    expect(hook).not.toMatch(/DeleteRegKey\s+SHCTX\s+"Software\\Classes\\\.chemdraft(?:\\OpenWithProgids)?"/);
    expect(hook).toMatch(/DeleteRegKey \/ifempty SHCTX "\$\{KEY\}"/);
    expect(hook).not.toMatch(/\.cdxml/i);
    const extensions = [...hook.matchAll(/Software\\Classes\\(\.[^"\\]+)/g)].map((match) => match[1]);
    expect(new Set(extensions)).toEqual(new Set([".chemdraft"]));
  });

  it("removes everything when this build was the only owner", () => {
    for (const build of [stable, dev]) {
      const reg = new Registry();
      install(reg, build);
      reg.write(`${EXT}\\OpenWithProgids`, build.progId, "");
      uninstall(reg, build);
      expect(reg.key(EXT)).toBeUndefined();
      expect(reg.key(`Software\\Classes\\${build.progId}`)).toBeUndefined();
    }
  });

  it("removes a reinstalled build's self-backup instead of restoring it", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, stable);
    uninstall(reg, stable);
    expect(reg.key(EXT)).toBeUndefined();
  });

  it("uninstalling the dev build keeps the stable build's handler in the same scope", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, dev);
    uninstall(reg, dev);
    expect(reg.read(EXT, "")).toBe(stable.progId);
    expect(command(reg, stable)).toBe(quoted(stable));
    expect(reg.read(EXT, `${stable.progId}_backup`)).toBe("");
    expect(reg.read(EXT, `${dev.progId}_backup`)).toBeUndefined();
    expect(reg.key(`Software\\Classes\\${dev.progId}`)).toBeUndefined();

    uninstall(reg, stable);
    expect(reg.key(EXT)).toBeUndefined();
  });

  it("uninstalling the stable build keeps the dev build's handler, then the dev build cleans up", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, dev);
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBe(dev.progId);
    expect(command(reg, dev)).toBe(quoted(dev));
    expect(reg.read(EXT, `${dev.progId}_backup`)).toBe(stable.progId);

    // The dev build's backup names the removed stable class, so it is not restored.
    uninstall(reg, dev);
    expect(reg.key(EXT)).toBeUndefined();
  });

  it("restores the program that owned .chemdraft before install and keeps its entries", () => {
    const reg = new Registry();
    reg.write(EXT, "", "Other.Viewer");
    reg.write(`${EXT}\\OpenWithProgids`, "Other.Viewer", "");
    reg.write("Software\\Classes\\Other.Viewer\\shell\\open\\command", "", "other.exe \"%1\"");
    install(reg, stable);
    reg.write(`${EXT}\\OpenWithProgids`, stable.progId, "");
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBe("Other.Viewer");
    expect(reg.read(`${EXT}\\OpenWithProgids`, "Other.Viewer")).toBe("");
    expect(reg.read(`${EXT}\\OpenWithProgids`, stable.progId)).toBeUndefined();
    expect(reg.read("Software\\Classes\\Other.Viewer\\shell\\open\\command", "")).toBe("other.exe \"%1\"");
  });

  it("keeps a program that claimed .chemdraft after install, and a missing default stays missing", () => {
    const reg = new Registry();
    install(reg, stable);
    reg.write(EXT, "", "Later.Editor");
    reg.write("Software\\Classes\\Later.Editor\\shell\\open\\command", "", "later.exe \"%1\"");
    reg.write(`${EXT}\\OpenWithProgids`, "Later.Editor", "");
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBe("Later.Editor");
    expect(reg.read(`${EXT}\\OpenWithProgids`, "Later.Editor")).toBe("");

    const missing = new Registry();
    install(missing, stable);
    missing.write(`${EXT}\\OpenWithProgids`, "Other.Viewer", "");
    missing.deleteValue(EXT, "");
    uninstall(missing, stable);
    expect(missing.read(EXT, "")).toBeUndefined();
    expect(missing.read(`${EXT}\\OpenWithProgids`, "Other.Viewer")).toBe("");
  });

  it("compares the owner case-sensitively", () => {
    const reg = new Registry();
    install(reg, stable);
    reg.write(EXT, "", stable.progId.toLowerCase());
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBe(stable.progId.toLowerCase());
  });
});

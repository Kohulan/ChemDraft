import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
)) as {
  bundle: {
    fileAssociations: Array<{ name: string; ext: string[] }>;
    windows: { nsis: { installerHooks: string } };
  };
};
const hook = readFileSync(
  new URL("../src-tauri/windows/installer-hooks.nsh", import.meta.url),
  "utf8",
);
const desktopTauriUrl = new URL("../../../scripts/desktop-tauri.mjs", import.meta.url);
const desktopTauri = readFileSync(desktopTauriUrl, "utf8");

const macroBody = (name: string) =>
  hook.match(new RegExp(`!macro ${name}(?:[ \\t]+[^\\n]*)?\\n([\\s\\S]*?)!macroend`))?.[1] ?? "";
const preInstall = macroBody("NSIS_HOOK_PREINSTALL");
const postInstall = macroBody("NSIS_HOOK_POSTINSTALL");
const pre = macroBody("NSIS_HOOK_PREUNINSTALL");
const post = macroBody("NSIS_HOOK_POSTUNINSTALL");

// ---------------------------------------------------------------------------------------------
// A small interpreter for the NSIS subset the hook uses, over an in-memory registry with separate
// HKCU and HKLM hives. HKCR is their merged view (a key in HKCU shadows the same key in HKLM), and
// SHCTX is HKLM for an all-users install and HKCU for a per-user one. It runs the hook's own text, so
// the scenarios below exercise the real logic. Macro parameters and defines are substituted as text,
// as makensis does, and the !if/!else/!endif lines in a macro are then resolved against them;
// LogicLib's If and Do blocks are parsed into a tree. Tauri's APP_ASSOCIATE and APP_UNASSOCIATE (FileAssociation.nsh, Tauri CLI 2.11.2) and the
// install and uninstall sections around the hooks are modeled in JS.
// ---------------------------------------------------------------------------------------------

type RegKey = { name: string; values: Map<string, { name: string; data: string }> };

class Hive {
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

// The template's INSTALLMODE; `both` adds MultiUser.nsh's runtime choice.
type InstallMode = "currentUser" | "perMachine" | "both:AllUsers" | "both:CurrentUser";

const CLASSES = "Software\\Classes\\";

// One machine as seen by the account running the installer. Its own methods address SHCTX.
class Registry {
  hkcu = new Hive();
  hklm = new Hive();

  constructor(readonly mode: InstallMode = "currentUser") {}

  get allUsers() {
    return this.mode === "perMachine" || this.mode === "both:AllUsers";
  }

  get shctx() {
    return this.allUsers ? this.hklm : this.hkcu;
  }

  hive(root: string) {
    if (root === "SHCTX") return this.shctx;
    if (root === "HKCU") return this.hkcu;
    if (root === "HKLM") return this.hklm;
    throw new Error(`Unexpected registry root ${root}`);
  }

  // HKCR: a key this user has in HKCU\Software\Classes shadows the machine's; subkeys are merged.
  classesKey(path: string) {
    return this.hkcu.key(CLASSES + path) ?? this.hklm.key(CLASSES + path);
  }

  classesSubkeys(path: string) {
    const names = new Map<string, string>();
    for (const name of [...this.hkcu.subkeys(CLASSES + path), ...this.hklm.subkeys(CLASSES + path)]) {
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    return [...names.values()];
  }

  // The open command .chemdraft's owner has for everyone this scope serves: the machine's class for
  // an all-users install, the class this user sees (HKCR) for a per-user one.
  openCommand(progId: string) {
    const path = `${progId}\\shell\\open\\command`;
    return this.allUsers ? this.hklm.read(CLASSES + path, "") : this.classesKey(path)?.values.get("")?.data;
  }

  key(path: string) { return this.shctx.key(path); }
  ensure(path: string) { return this.shctx.ensure(path); }
  read(path: string, name: string) { return this.shctx.read(path, name); }
  write(path: string, name: string, data: string) { this.shctx.write(path, name, data); }
  deleteValue(path: string, name: string) { this.shctx.deleteValue(path, name); }
  deleteKey(path: string, ifEmpty = false) { this.shctx.deleteKey(path, ifEmpty); }
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

type Cond = { join: "and" | "or"; negate: boolean; tokens: string[] };
type Block =
  | { kind: "if"; branches: Array<{ conds: Cond[]; body: Node[] }>; otherwise: Node[] }
  | { kind: "do"; body: Node[] };
type Node = { kind: "cmd"; tokens: string[]; raw: string } | Block;

// LogicLib's block macros, parsed into a tree.
function parse(lines: string[]) {
  const root: Node[] = [];
  const open: Array<{ block: Block; body: Node[] }> = [];
  const body = () => open[open.length - 1]?.body ?? root;
  const top = (kind: Block["kind"], raw: string) => {
    const entry = open[open.length - 1];
    if (entry?.block.kind !== kind) throw new Error(`Unbalanced ${raw}`);
    return entry as { block: Extract<Block, { kind: typeof kind }>; body: Node[] };
  };
  for (const raw of lines) {
    const tokens = tokenize(raw.trim());
    if (tokens.length === 0) continue;
    const [cmd, ...rest] = tokens;
    switch (cmd) {
      case "${If}":
      case "${IfNot}": {
        const branch = { conds: [{ join: "and" as const, negate: cmd === "${IfNot}", tokens: rest }], body: [] as Node[] };
        const block: Block = { kind: "if", branches: [branch], otherwise: [] };
        body().push(block);
        open.push({ block, body: branch.body });
        continue;
      }
      case "${AndIf}":
      case "${OrIf}": {
        const entry = top("if", raw) as { block: Extract<Block, { kind: "if" }> };
        entry.block.branches[entry.block.branches.length - 1]!.conds.push({ join: cmd === "${AndIf}" ? "and" : "or", negate: false, tokens: rest });
        continue;
      }
      case "${ElseIf}": {
        const entry = top("if", raw) as { block: Extract<Block, { kind: "if" }>; body: Node[] };
        const branch = { conds: [{ join: "and" as const, negate: false, tokens: rest }], body: [] as Node[] };
        entry.block.branches.push(branch);
        entry.body = branch.body;
        continue;
      }
      case "${Else}": {
        const entry = top("if", raw) as { block: Extract<Block, { kind: "if" }>; body: Node[] };
        entry.body = entry.block.otherwise;
        continue;
      }
      case "${EndIf}":
        top("if", raw);
        open.pop();
        continue;
      case "${Do}": {
        const block: Block = { kind: "do", body: [] };
        body().push(block);
        open.push({ block, body: block.body });
        continue;
      }
      case "${Loop}":
        top("do", raw);
        open.pop();
        continue;
      default:
        body().push({ kind: "cmd", tokens, raw: raw.trim() });
    }
  }
  if (open.length > 0) throw new Error("Unclosed LogicLib block");
  return root;
}

type Build = { productName: string; progId: string; instDir: string };

class Nsis {
  vars = new Map<string, string>();
  stack: string[] = [];
  error = false;
  notified = 0;
  steps = 0;
  macros = new Map<string, { params: string[]; body: string[] }>();

  constructor(readonly reg: Registry, readonly build: Build) {
    for (const match of hook.matchAll(/^Var\s+(\S+)/gm)) this.vars.set(match[1]!, "");
    for (const name of ["0", "1", "INSTDIR"]) this.vars.set(name, "");
    this.vars.set("INSTDIR", build.instDir);
    // MultiUser.nsh declares this only in `both` mode.
    if (reg.mode.startsWith("both:")) this.vars.set("MultiUser.InstallMode", reg.mode === "both:AllUsers" ? "AllUsers" : "CurrentUser");
    const macroDefs = hook.matchAll(/^!macro\s+(\S+)([^\n]*)\n([\s\S]*?)^!macroend/gm);
    for (const [, name, params, body] of macroDefs) {
      this.macros.set(name!, { params: params!.trim().split(/\s+/).filter(Boolean), body: body!.split("\n") });
    }
  }

  get uninstKey() {
    return uninstKey(this.build);
  }

  // Runtime string expansion: $\" and declared variables, longest name first, as makensis does.
  expand(s: string) {
    if (/\$\{/.test(s)) throw new Error(`Unexpanded define in ${s}`);
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
    return out;
  }

  setVar(token: string, value: string) {
    const name = token.slice(1);
    if (!token.startsWith("$") || !this.vars.has(name)) throw new Error(`Undeclared variable ${token}`);
    this.vars.set(name, value);
  }

  get installMode() {
    return this.reg.mode.startsWith("both:") ? "both" : this.reg.mode;
  }

  // makensis's !if, !else [if] and !endif inside a macro body, after defines are substituted.
  preprocess(lines: string[]) {
    const out: string[] = [];
    const open: Array<{ parent: boolean; taken: boolean; active: boolean }> = [];
    const active = () => open.length === 0 || open[open.length - 1]!.active;
    const test = (tokens: string[], raw: string) => {
      if (tokens.length !== 3) throw new Error(`Unsupported directive ${raw}`);
      const [a, op, b] = tokens;
      if (op === "==") return a!.toLowerCase() === b!.toLowerCase();
      if (op === "!=") return a!.toLowerCase() !== b!.toLowerCase();
      throw new Error(`Unsupported directive ${raw}`);
    };
    for (const raw of lines) {
      const [cmd, ...rest] = tokenize(raw.trim());
      if (cmd === "!if") {
        const parent = active();
        const value = parent && test(rest, raw);
        open.push({ parent, taken: value, active: value });
      } else if (cmd === "!else") {
        const entry = open[open.length - 1];
        if (!entry) throw new Error(`Unbalanced ${raw}`);
        const value = rest[0] === "if" ? test(rest.slice(1), raw) : true;
        entry.active = entry.parent && !entry.taken && value;
        entry.taken ||= entry.active;
      } else if (cmd === "!endif") {
        if (!open.pop()) throw new Error(`Unbalanced ${raw}`);
      } else if (cmd?.startsWith("!") && cmd !== "!insertmacro") {
        throw new Error(`Unsupported directive ${raw}`);
      } else if (active()) {
        out.push(raw);
      }
    }
    if (open.length > 0) throw new Error("Unclosed !if");
    return out;
  }

  cond(tokens: string[]) {
    if (tokens.length === 1 && tokens[0] === "${Errors}") {
      // IfErrors checks and clears the error flag.
      const value = this.error;
      this.error = false;
      return value;
    }
    if (tokens.length !== 3) throw new Error(`Unsupported condition ${tokens.join(" ")}`);
    const [a, op, b] = tokens;
    const left = this.expand(a!);
    const right = this.expand(b!);
    const int = (value: string) => {
      if (!/^-?\d+$/.test(value)) throw new Error(`Not an integer: ${value}`);
      return Number(value);
    };
    switch (op) {
      case "==": return left.toLowerCase() === right.toLowerCase();
      case "!=": return left.toLowerCase() !== right.toLowerCase();
      case "S==": return left === right;
      case "S!=": return left !== right;
      case "=": return int(left) === int(right);
      case "<>": return int(left) !== int(right);
      case "<": return int(left) < int(right);
      case ">": return int(left) > int(right);
      case "<=": return int(left) <= int(right);
      case ">=": return int(left) >= int(right);
      default: throw new Error(`Unsupported condition ${tokens.join(" ")}`);
    }
  }

  // Inserts a macro: parameters and defines are replaced as text before the lines are parsed.
  run(macro: string, args: string[] = []) {
    const def = this.macros.get(macro);
    if (!def) {
      if (macro === "SetContext") return;
      if (macro === "UPDATEFILEASSOC") { this.notified++; return; }
      throw new Error(`Unknown macro ${macro}`);
    }
    if (args.length !== def.params.length) throw new Error(`${macro} expects ${def.params.length} arguments`);
    const defines: Record<string, string> = {
      MAINBINARYNAME: "chemdraft",
      INSTALLMODE: this.installMode,
      UNINSTKEY: this.uninstKey,
      CHEMDRAFT_ASSOCIATION_PROGID: this.build.progId,
      ...Object.fromEntries(def.params.map((param, index) => [param, args[index]!])),
    };
    const lines = def.body.map((line) => line.replace(/\$\{([A-Za-z_]\w*)\}/g, (whole, name: string) => defines[name] ?? whole));
    if (this.exec(parse(this.preprocess(lines))) === "exit") throw new Error(`\${ExitDo} outside a loop in ${macro}`);
  }

  exec(nodes: Node[]): "exit" | undefined {
    for (const node of nodes) {
      if (node.kind === "if") {
        const branch = node.branches.find((candidate) => candidate.conds.reduce<boolean | undefined>((value, cond) => {
          const result = this.cond(cond.tokens) !== cond.negate;
          if (value === undefined) return result;
          return cond.join === "and" ? value && result : value || result;
        }, undefined));
        if (this.exec(branch ? branch.body : node.otherwise) === "exit") return "exit";
      } else if (node.kind === "do") {
        while (this.exec(node.body) !== "exit") {
          if (++this.steps > 10_000) throw new Error("Runaway loop");
        }
      } else if (this.command(node.tokens, node.raw) === "exit") {
        return "exit";
      }
    }
    return undefined;
  }

  command([cmd, ...rest]: string[], raw: string): "exit" | undefined {
    const x = (index: number) => this.expand(rest[index]!);
    switch (cmd) {
      case "${ExitDo}":
        return "exit";
      case "ReadRegStr": {
        const value = rest[1] === "HKCR"
          ? this.reg.classesKey(x(2))?.values.get(x(3).toLowerCase())?.data
          : this.reg.hive(rest[1]!).read(x(2), x(3));
        if (value === undefined) this.error = true;
        this.setVar(rest[0]!, value ?? "");
        break;
      }
      case "WriteRegStr":
        this.reg.hive(rest[0]!).write(x(1), x(2), x(3));
        break;
      case "DeleteRegValue":
        this.reg.hive(rest[0]!).deleteValue(x(1), x(2));
        break;
      case "DeleteRegKey": {
        const ifEmpty = rest[0] === "/ifempty";
        const args = ifEmpty ? rest.slice(1) : rest;
        const path = this.expand(args[1]!);
        if (/\\$/.test(path) || path.toLowerCase() === "software\\classes") throw new Error(`Refusing to delete ${path}`);
        this.reg.hive(args[0]!).deleteKey(path, ifEmpty);
        break;
      }
      case "EnumRegKey":
      case "EnumRegValue": {
        const hkcr = rest[1] === "HKCR";
        const hive = hkcr ? undefined : this.reg.hive(rest[1]!);
        const path = x(2);
        const key = hive ? hive.key(path) : this.reg.classesKey(path);
        if (!key) { this.error = true; this.setVar(rest[0]!, ""); break; }
        const names = cmd === "EnumRegValue"
          ? [...key.values.values()].map((v) => v.name)
          : hive ? hive.subkeys(path) : this.reg.classesSubkeys(path);
        this.setVar(rest[0]!, names[Number(x(3))] ?? "");
        break;
      }
      case "StrCpy": {
        let value = x(1);
        const offset = rest[3] === undefined ? 0 : Number(x(3));
        value = value.slice(offset < 0 ? Math.max(0, value.length + offset) : offset);
        if (rest[2] !== undefined && x(2) !== "") {
          const length = Number(x(2));
          value = length < 0 ? value.slice(0, Math.max(0, value.length + length)) : value.slice(0, length);
        }
        this.setVar(rest[0]!, value);
        break;
      }
      case "IntOp": {
        if (rest[2] !== "+") throw new Error(`Unsupported IntOp ${raw}`);
        this.setVar(rest[0]!, String(Number(x(1)) + Number(x(3))));
        break;
      }
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
        this.run(rest[0]!, rest.slice(1));
        break;
      default:
        throw new Error(`Unsupported NSIS command: ${raw}`);
    }
    return undefined;
  }
}

const EXT = "Software\\Classes\\.chemdraft";
const OPEN_WITH = `${EXT}\\OpenWithProgids`;
const stableName = config.bundle.fileAssociations.find((association) => association.ext.includes("chemdraft"))!.name;
const stable: Build = { productName: "ChemDraft", progId: stableName, instDir: "C:\\Program Files\\ChemDraft" };
const dev: Build = { productName: "ChemDraft (dev)", progId: `${stableName} (dev)`, instDir: "C:\\Program Files\\ChemDraft (dev)" };

function uninstKey(build: Build) {
  return `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${build.productName}`;
}

const classKey = (progId: string) => `Software\\Classes\\${progId}`;
const command = (reg: Registry, build: Build) => reg.read(`${classKey(build.progId)}\\shell\\open\\command`, "");
const quoted = (build: Build) => `"${build.instDir}\\chemdraft.exe" "%1"`;
// A class opens .chemdraft only when its open command has a value, in the scope .chemdraft is in.
const opens = (reg: Registry, progId: string) => (reg.openCommand(progId) ?? "") !== "";

function registerProgram(reg: Registry, progId: string) {
  reg.write(`${classKey(progId)}\\shell\\open\\command`, "", `${progId}.exe "%1"`);
}

// The template's install section, reduced to what touches the association. With `interrupted`, the
// installer stops after APP_ASSOCIATE (and WriteUninstaller), before NSIS_HOOK_POSTINSTALL.
function install(reg: Registry, build: Build, { interrupted = false } = {}) {
  const nsis = new Nsis(reg, build);
  nsis.run("NSIS_HOOK_PREINSTALL");
  // APP_ASSOCIATE
  reg.write(EXT, `${build.progId}_backup`, reg.read(EXT, "") ?? "");
  reg.write(EXT, "", build.progId);
  reg.write(classKey(build.progId), "", "ChemDraft CDXML document");
  reg.write(`${classKey(build.progId)}\\DefaultIcon`, "", `${build.instDir}\\chemdraft.exe,0`);
  reg.write(`${classKey(build.progId)}\\shell`, "", "open");
  reg.write(`${classKey(build.progId)}\\shell\\open`, "", `Open with ${build.productName}`);
  reg.write(`${classKey(build.progId)}\\shell\\open\\command`, "", `${build.instDir}\\chemdraft.exe "%1"`);
  if (interrupted) return;
  reg.write(nsis.uninstKey, "DisplayName", build.productName);
  nsis.run("NSIS_HOOK_POSTINSTALL");
  expect(nsis.stack).toEqual([]);
}

// The template's uninstall section, reduced the same way.
function uninstall(reg: Registry, build: Build) {
  const nsis = new Nsis(reg, build);
  nsis.run("NSIS_HOOK_PREUNINSTALL");
  // APP_UNASSOCIATE
  reg.write(EXT, "", reg.read(EXT, `${build.progId}_backup`) ?? "");
  reg.deleteKey(classKey(build.progId));
  reg.deleteKey(nsis.uninstKey);
  nsis.run("NSIS_HOOK_POSTUNINSTALL");
  expect(nsis.notified).toBe(1);
  expect(nsis.stack).toEqual([]);
}

// .chemdraft never points at a class that cannot open it.
function expectSound(reg: Registry) {
  const owner = reg.read(EXT, "");
  if (owner !== undefined) expect(opens(reg, owner), `.chemdraft names ${JSON.stringify(owner)}, which has no open command`).toBe(true);
}

// Nothing this build registered is left behind.
function expectGone(reg: Registry, build: Build) {
  expect(reg.key(classKey(build.progId))).toBeUndefined();
  expect(reg.read(EXT, `${build.progId}_backup`)).toBeUndefined();
  expect(reg.read(OPEN_WITH, build.progId)).toBeUndefined();
  expect(reg.key(uninstKey(build))).toBeUndefined();
}

function expectOwner(reg: Registry, owner: string) {
  expect(reg.read(EXT, "")).toBe(owner);
  expect(opens(reg, owner)).toBe(true);
}

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
      expect(reg.read(uninstKey(build), "ChemDraftAssociationProgId")).toBe(build.progId);
    }
  });

  it("never hard-codes either build's ProgID", () => {
    expect(hook).not.toMatch(/^[^;\n]*"[^"\n]*ChemDraft Document/m);
    // Everything is written in the install's own scope.
    expect(hook).not.toMatch(/^\s*(?:WriteRegStr|WriteRegExpandStr|DeleteRegKey|DeleteRegValue)\s+(?:\/ifempty\s+)?(?:HKCU|HKLM|HKCR)\b/m);
    // Fixed hives are only read, to check an owner's open command, and HKCR is never used.
    expect(hook).not.toMatch(/^[^;\n]*\bHKCR\b/m);
    const fixed = (text: string) => text.match(/^\s*\S+\s+\S+\s+(?:HKCU|HKLM)\b/gm) ?? [];
    const validation = macroBody("ChemDraftUserOpenCommand") + macroBody("ChemDraftHasOpenCommand");
    expect(fixed(hook)).toEqual(fixed(validation));
    expect(fixed(validation).length).toBeGreaterThan(0);
  });
});

describe("Windows association ProgID built into the installer", () => {
  it("takes the ProgID from the build environment at compile time and fails the build without it", () => {
    expect(hook).toMatch(/^!define CHEMDRAFT_ASSOCIATION_PROGID "\$%CHEMDRAFT_ASSOCIATION_PROGID%"$/m);
    expect(hook).toMatch(/^!searchreplace CHEMDRAFT_ASSOCIATION_PROGID_CHECK "\$\{CHEMDRAFT_ASSOCIATION_PROGID\}" "%CHEMDRAFT_ASSOCIATION_PROGID%" ""$/m);
    expect(hook).toMatch(/^!if "\$\{CHEMDRAFT_ASSOCIATION_PROGID_CHECK\}" != "\$\{CHEMDRAFT_ASSOCIATION_PROGID\}"\n\s+!error /m);
    expect(hook).toMatch(/^!if "\$\{CHEMDRAFT_ASSOCIATION_PROGID\}" == ""\n\s+!error /m);
    // Every hook falls back to it when no install recorded this build's ProgID.
    for (const body of [preInstall, postInstall, pre]) {
      expect(body).toMatch(/\$\{If\} \$ChemDraftAssociationOwnProgId == ""\n\s+StrCpy \$ChemDraftAssociationOwnProgId "\$\{CHEMDRAFT_ASSOCIATION_PROGID\}"/);
    }
  });

  it("is set by the build script from the association name Tauri is given", () => {
    expect(desktopTauri).toContain("const devAssociations = isBranchBuild ? devFileAssociations() : undefined;");
    expect(desktopTauri).toContain("bundle: { fileAssociations: devAssociations }");
    expect(desktopTauri).toContain("const progId = chemdraftAssociationName(devAssociations ?? windowsFileAssociations());");
    expect(desktopTauri).toContain("if (progId) env.CHEMDRAFT_ASSOCIATION_PROGID = progId;");
    const script = `import { chemdraftAssociationName } from ${JSON.stringify(desktopTauriUrl.href)};
      const config = JSON.parse(process.argv[1]);
      const dev = config.bundle.fileAssociations.map((association) => ({ ...association, name: association.name + " (dev)" }));
      console.log(JSON.stringify([chemdraftAssociationName(config.bundle.fileAssociations), chemdraftAssociationName(dev), chemdraftAssociationName([])]));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(config)], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([stable.progId, dev.progId, null]);
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
      reg.write(OPEN_WITH, build.progId, "");
      uninstall(reg, build);
      expect(reg.key(EXT)).toBeUndefined();
      expectGone(reg, build);
    }
  });

  it("removes a reinstalled build's self-backup instead of restoring it", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, stable);
    expect(reg.read(EXT, `${stable.progId}_backup`)).toBe("");
    uninstall(reg, stable);
    expect(reg.key(EXT)).toBeUndefined();
    expectGone(reg, stable);
  });

  it("uninstalling the dev build keeps the stable build's handler in the same scope", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, dev);
    uninstall(reg, dev);
    expectOwner(reg, stable.progId);
    expect(command(reg, stable)).toBe(quoted(stable));
    expect(reg.read(EXT, `${stable.progId}_backup`)).toBe("");
    expectGone(reg, dev);

    uninstall(reg, stable);
    expect(reg.key(EXT)).toBeUndefined();
    expectGone(reg, stable);
  });

  it("uninstalling the stable build keeps the dev build's handler, then the dev build cleans up", () => {
    const reg = new Registry();
    install(reg, stable);
    install(reg, dev);
    uninstall(reg, stable);
    expectOwner(reg, dev.progId);
    expect(command(reg, dev)).toBe(quoted(dev));
    // The dev build's backup named the removed stable class; it now names what stable replaced.
    expect(reg.read(EXT, `${dev.progId}_backup`)).toBe("");
    expectGone(reg, stable);

    uninstall(reg, dev);
    expect(reg.key(EXT)).toBeUndefined();
    expectGone(reg, dev);
  });

  it("restores the program that owned .chemdraft before install and keeps its entries", () => {
    const reg = new Registry();
    reg.write(EXT, "", "Other.Viewer");
    reg.write(OPEN_WITH, "Other.Viewer", "");
    registerProgram(reg, "Other.Viewer");
    install(reg, stable);
    reg.write(OPEN_WITH, stable.progId, "");
    uninstall(reg, stable);
    expectOwner(reg, "Other.Viewer");
    expect(reg.read(OPEN_WITH, "Other.Viewer")).toBe("");
    expect(reg.read("Software\\Classes\\Other.Viewer\\shell\\open\\command", "")).toBe("Other.Viewer.exe \"%1\"");
    expectGone(reg, stable);
  });

  it("keeps a program that claimed .chemdraft after install, and a missing default stays missing", () => {
    const reg = new Registry();
    install(reg, stable);
    reg.write(EXT, "", "Later.Editor");
    registerProgram(reg, "Later.Editor");
    reg.write(OPEN_WITH, "Later.Editor", "");
    uninstall(reg, stable);
    expectOwner(reg, "Later.Editor");
    expect(reg.read(OPEN_WITH, "Later.Editor")).toBe("");
    expectGone(reg, stable);

    const missing = new Registry();
    install(missing, stable);
    missing.write(OPEN_WITH, "Other.Viewer", "");
    missing.deleteValue(EXT, "");
    uninstall(missing, stable);
    expect(missing.read(EXT, "")).toBeUndefined();
    expect(missing.read(OPEN_WITH, "Other.Viewer")).toBe("");
    expectGone(missing, stable);
  });

  it("never writes back a later owner whose class no longer opens files", () => {
    const reg = new Registry();
    registerProgram(reg, "Other.Viewer");
    reg.write(EXT, "", "Other.Viewer");
    install(reg, stable);
    reg.write(EXT, "", "Gone.Editor");
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBeUndefined();
    expect(reg.key(EXT)).toBeUndefined();
    expectGone(reg, stable);
  });
});

describe("Windows file association owner across reinstalls and updates", () => {
  it("keeps the owner from before the first install through reinstall and /UPDATE, then restores it", () => {
    for (const build of [stable, dev]) {
      const reg = new Registry();
      registerProgram(reg, "Notepad.Doc");
      reg.write(EXT, "", "Notepad.Doc");
      install(reg, build); // first install
      install(reg, build); // reinstall over the same build
      install(reg, build); // /UPDATE installs over the running build without uninstalling first
      expect(reg.read(EXT, `${build.progId}_backup`)).toBe("Notepad.Doc");
      expect(reg.read(uninstKey(build), "ChemDraftAssociationPreviousOwner")).toBe("Notepad.Doc");
      expect(command(reg, build)).toBe(quoted(build));
      uninstall(reg, build);
      expectOwner(reg, "Notepad.Doc");
      expectGone(reg, build);
    }
  });

  it("restores the saved owner when an interrupted reinstall left a self-backup", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "Notepad.Doc");
    install(reg, stable);
    install(reg, stable, { interrupted: true });
    expect(reg.read(EXT, `${stable.progId}_backup`)).toBe(stable.progId);
    uninstall(reg, stable);
    expectOwner(reg, "Notepad.Doc");
    expectGone(reg, stable);
  });

  it("re-saves the owner when an upgrade runs the old uninstaller first", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "Notepad.Doc");
    install(reg, stable);
    uninstall(reg, stable);
    expectOwner(reg, "Notepad.Doc");
    install(reg, stable);
    install(reg, stable);
    uninstall(reg, stable);
    expectOwner(reg, "Notepad.Doc");
    expectGone(reg, stable);
  });

  it("does not restore a saved owner whose class was removed while ChemDraft was installed", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "Notepad.Doc");
    install(reg, stable);
    install(reg, stable);
    reg.deleteKey(classKey("Notepad.Doc"));
    uninstall(reg, stable);
    expect(reg.key(EXT)).toBeUndefined();
    expectGone(reg, stable);
  });

  const orders = [[stable, dev], [dev, stable]] as const;
  for (const mode of ["currentUser", "perMachine"] as const)
  for (const foreign of [true, false]) {
    for (const [first, second] of orders) {
      for (const reinstallFirst of [false, true]) {
        for (const uninstallFirst of [first, second]) {
          const other = uninstallFirst === first ? second : first;
          const name = `${mode}, ${foreign ? "with" : "without"} an original owner: install ${first.productName}, then ${second.productName}` +
            `${reinstallFirst ? `, reinstall ${first.productName}` : ""}; uninstall ${uninstallFirst.productName} first`;
          it(name, () => {
            const reg = new Registry(mode);
            if (foreign) {
              registerProgram(reg, "Notepad.Doc");
              reg.write(EXT, "", "Notepad.Doc");
            }
            install(reg, first);
            install(reg, second);
            install(reg, second); // /UPDATE of the build on top
            if (reinstallFirst) install(reg, first);
            expectSound(reg);
            expectOwner(reg, reinstallFirst ? first.progId : second.progId);

            uninstall(reg, uninstallFirst);
            expectSound(reg);
            expectOwner(reg, other.progId);
            expect(command(reg, other)).toBe(quoted(other));
            expectGone(reg, uninstallFirst);

            install(reg, other); // /UPDATE of the remaining build
            uninstall(reg, other);
            expectSound(reg);
            if (foreign) expectOwner(reg, "Notepad.Doc");
            else expect(reg.key(EXT)).toBeUndefined();
            expectGone(reg, other);
          });
        }
      }
    }
  }
});

describe("Windows file association without a recorded ProgID", () => {
  // An install that stopped before NSIS_HOOK_POSTINSTALL, or one made before these hooks, has no
  // ChemDraftAssociationProgId (and no saved owner) in its uninstall key.
  const forget = (reg: Registry, build: Build) => {
    reg.deleteValue(uninstKey(build), "ChemDraftAssociationProgId");
    reg.deleteValue(uninstKey(build), "ChemDraftAssociationPreviousOwner");
  };

  it("restores the original owner when this build still owns .chemdraft", () => {
    for (const build of [stable, dev]) {
      const reg = new Registry();
      registerProgram(reg, "Notepad.Doc");
      reg.write(EXT, "", "Notepad.Doc");
      install(reg, build);
      forget(reg, build);
      uninstall(reg, build);
      expectOwner(reg, "Notepad.Doc");
      expectGone(reg, build);
    }
  });

  it("removes the default and every trace when nothing owned .chemdraft before", () => {
    for (const build of [stable, dev]) {
      const reg = new Registry();
      install(reg, build);
      reg.write(OPEN_WITH, build.progId, "");
      forget(reg, build);
      uninstall(reg, build);
      expect(reg.key(EXT)).toBeUndefined();
      expectGone(reg, build);
    }
  });

  it("keeps a foreign owner and still removes this build's entries", () => {
    const reg = new Registry();
    install(reg, stable);
    registerProgram(reg, "Later.Editor");
    reg.write(EXT, "", "Later.Editor");
    reg.write(OPEN_WITH, stable.progId, "");
    forget(reg, stable);
    uninstall(reg, stable);
    expectOwner(reg, "Later.Editor");
    expectGone(reg, stable);
  });

  it("cleans up after an install interrupted before its post-install hook", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "Notepad.Doc");
    install(reg, stable, { interrupted: true });
    expect(reg.read(uninstKey(stable), "ChemDraftAssociationProgId")).toBeUndefined();
    uninstall(reg, stable);
    expectOwner(reg, "Notepad.Doc");
    expectGone(reg, stable);
  });
});

describe("Windows file association ownership ignores ProgID case", () => {
  it("treats a case-only change of this build's ProgID as this build's and leaves no dangling default", () => {
    for (const foreign of [true, false]) {
      const reg = new Registry();
      if (foreign) {
        registerProgram(reg, "Notepad.Doc");
        reg.write(EXT, "", "Notepad.Doc");
      }
      install(reg, stable);
      reg.write(EXT, "", stable.progId.toLowerCase());
      uninstall(reg, stable);
      expectSound(reg);
      expect(reg.key(classKey(stable.progId.toLowerCase()))).toBeUndefined();
      if (foreign) expectOwner(reg, "Notepad.Doc");
      else expect(reg.key(EXT)).toBeUndefined();
      expectGone(reg, stable);
    }
  });

  it("keeps the original owner when a reinstall finds a case-only change", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "Notepad.Doc");
    install(reg, stable);
    reg.write(EXT, "", stable.progId.toUpperCase());
    install(reg, stable);
    expect(reg.read(EXT, `${stable.progId}_backup`)).toBe("Notepad.Doc");
    expect(command(reg, stable)).toBe(quoted(stable));
    uninstall(reg, stable);
    expectOwner(reg, "Notepad.Doc");
    expectGone(reg, stable);
  });

  it("restores another owner under the class's own case, which still has its open command", () => {
    const reg = new Registry();
    registerProgram(reg, "Notepad.Doc");
    reg.write(EXT, "", "notepad.doc");
    install(reg, stable);
    uninstall(reg, stable);
    expect(reg.read(EXT, "")).toBe("notepad.doc");
    expect(opens(reg, "notepad.doc")).toBe(true);
    expect(reg.read(`${classKey("Notepad.Doc")}\\shell\\open\\command`, "")).toBe("Notepad.Doc.exe \"%1\"");
    expectGone(reg, stable);
  });
});

describe("Windows file association owner validation", () => {
  const COMMAND = (progId: string) => `${classKey(progId)}\\shell\\open\\command`;

  // An owner whose class has an open command key, but one that opens nothing.
  const hollow = {
    "with no default value": (hive: Hive, progId: string) => { hive.ensure(COMMAND(progId)); },
    "with an empty default value": (hive: Hive, progId: string) => { hive.write(COMMAND(progId), "", ""); },
  };

  for (const [what, leave] of Object.entries(hollow)) {
    it(`does not restore the owner this build replaced when its open command key is left ${what}`, () => {
      for (const mode of ["currentUser", "perMachine"] as const) {
        const reg = new Registry(mode);
        registerProgram(reg, "Notepad.Doc");
        reg.write(EXT, "", "Notepad.Doc");
        install(reg, stable);
        reg.deleteKey(classKey("Notepad.Doc"));
        leave(reg.shctx, "Notepad.Doc");
        uninstall(reg, stable);
        expect(reg.read(EXT, "")).toBeUndefined();
        expect(reg.key(EXT)).toBeUndefined();
        expectGone(reg, stable);
      }
    });

    it(`does not write back a later owner whose open command key is left ${what}`, () => {
      for (const mode of ["currentUser", "perMachine"] as const) {
        const reg = new Registry(mode);
        install(reg, stable);
        leave(reg.shctx, "Later.Editor");
        reg.write(EXT, "", "Later.Editor");
        uninstall(reg, stable);
        expect(reg.read(EXT, "")).toBeUndefined();
        expect(reg.key(EXT)).toBeUndefined();
        expectGone(reg, stable);
      }
    });
  }

  for (const mode of ["perMachine", "both:AllUsers"] as const) {
    it(`${mode}: does not restore into HKLM an owner whose class only the uninstalling administrator has`, () => {
      const reg = new Registry(mode);
      registerProgram(reg, "Admin.Viewer");
      reg.write(EXT, "", "Admin.Viewer");
      install(reg, stable);
      // The administrator's own class: HKCR shows it to them, but no other user has it.
      reg.hklm.deleteKey(classKey("Admin.Viewer"));
      reg.hkcu.write(COMMAND("Admin.Viewer"), "", "Admin.Viewer.exe \"%1\"");
      uninstall(reg, stable);
      expect(reg.hklm.read(EXT, "")).toBeUndefined();
      expect(reg.hklm.key(EXT)).toBeUndefined();
      expect(reg.hkcu.read(COMMAND("Admin.Viewer"), "")).toBe("Admin.Viewer.exe \"%1\"");
      expectGone(reg, stable);
    });

    it(`${mode}: does not write back a later owner whose class only the uninstalling administrator has`, () => {
      const reg = new Registry(mode);
      install(reg, stable);
      reg.hkcu.write(COMMAND("Later.Editor"), "", "Later.Editor.exe \"%1\"");
      reg.hklm.write(EXT, "", "Later.Editor");
      uninstall(reg, stable);
      expect(reg.hklm.key(EXT)).toBeUndefined();
      expectGone(reg, stable);
    });

    it(`${mode}: restores an owner whose class is registered for the machine`, () => {
      const reg = new Registry(mode);
      reg.hklm.write(COMMAND("Machine.Viewer"), "", "Machine.Viewer.exe \"%1\"");
      reg.hklm.write(EXT, "", "Machine.Viewer");
      install(reg, stable);
      install(reg, stable);
      uninstall(reg, stable);
      expectOwner(reg, "Machine.Viewer");
      expect(reg.hkcu.key(EXT)).toBeUndefined();
      expectGone(reg, stable);
    });
  }

  for (const mode of ["currentUser", "both:CurrentUser"] as const) {
    it(`${mode}: restores an owner whose class is registered only for the machine`, () => {
      const reg = new Registry(mode);
      reg.hklm.write(COMMAND("Machine.Viewer"), "", "Machine.Viewer.exe \"%1\"");
      reg.hkcu.write(EXT, "", "Machine.Viewer");
      install(reg, stable);
      uninstall(reg, stable);
      expect(reg.hkcu.read(EXT, "")).toBe("Machine.Viewer");
      expectOwner(reg, "Machine.Viewer");
      expectGone(reg, stable);
    });

    it(`${mode}: keeps a later owner whose class is registered only for the machine`, () => {
      const reg = new Registry(mode);
      install(reg, stable);
      reg.hklm.write(COMMAND("Later.Editor"), "", "Later.Editor.exe \"%1\"");
      reg.hkcu.write(EXT, "", "Later.Editor");
      uninstall(reg, stable);
      expectOwner(reg, "Later.Editor");
      expectGone(reg, stable);
    });

    it(`${mode}: does not restore an owner whose empty class of this user's shadows the machine's`, () => {
      const reg = new Registry(mode);
      reg.hklm.write(COMMAND("Machine.Viewer"), "", "Machine.Viewer.exe \"%1\"");
      reg.hkcu.write(EXT, "", "Machine.Viewer");
      install(reg, stable);
      reg.hkcu.write(COMMAND("Machine.Viewer"), "", "");
      uninstall(reg, stable);
      expect(reg.hkcu.key(EXT)).toBeUndefined();
      expectGone(reg, stable);
    });
  }
});

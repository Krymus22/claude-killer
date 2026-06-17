/**
 * lspAst.test.ts — Tests for AST parsing module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile, parseSource, findSymbol, findDependencies } from "../lspAst.js";

const TEST_DIR = path.join(process.cwd(), "__test_astdir__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, "types.ts"),
    `export interface User { name: string; age: number; }
export type ID = string | number;
export function greet(name: string): string { return "Hello " + name; }
export class Calculator { add(a: number, b: number) { return a + b; } }
const internal = 42;
import { foo } from "bar";
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "python.py"),
    `def hello():
    pass

class Foo:
    def bar(self):
        pass

from os import path
import sys
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "rust.rs"),
    `pub fn add(a: i32, b: i32) -> i32 { a + b }
struct Point { x: f64, y: f64 }
enum Color { Red, Green, Blue }
trait Drawable { fn draw(&self); }
use std::collections::HashMap;
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "go.go"),
    `package main
import "fmt"
func main() { fmt.Println("hello") }
type User struct { Name string }
interface Stringer { String() string }
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "app.java"),
    `package com.example;

import java.util.List;
import static java.lang.Math.PI;

public class App {
    public void run() {
        System.out.println("hello");
    }
}

interface Serializable {}
`,
    "utf8"
  );
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseFile", () => {
  it("should parse TypeScript file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    expect(result.language).toBe("tree-sitter-typescript");
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should detect exported symbols", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const exported = result.symbols.filter((s) => s.exported);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.some((s) => s.name === "greet")).toBe(true);
  });

  it("should parse Python file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "python.py"));
    expect(result.language).toBe("tree-sitter-python");
    expect(result.symbols.some((s) => s.name === "hello")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Foo")).toBe(true);
  });

  it("should parse Rust file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "rust.rs"));
    expect(result.language).toBe("tree-sitter-rust");
    expect(result.symbols.some((s) => s.name === "add")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Point")).toBe(true);
  });

  it("should parse Go file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "go.go"));
    expect(result.language).toBe("tree-sitter-go");
    expect(result.symbols.some((s) => s.name === "main")).toBe(true);
  });

  it("should return empty for non-existent file", async () => {
    const result = await parseFile("/nonexistent/file.ts");
    expect(result.lineCount).toBe(0);
  });
});

describe("parseSource", () => {
  it("should parse source string", async () => {
    const result = await parseSource("const x = 1;\nexport function foo() {}", "tree-sitter-typescript");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
  });
});

describe("findSymbol", () => {
  it("should find a specific symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "greet");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("function");
  });

  it("should return undefined for non-existent symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "nonexistent");
    expect(symbol).toBeUndefined();
  });
});

describe("findDependencies", () => {
  it("should extract imports", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const deps = findDependencies(result);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0]).toHaveProperty("module");
    expect(deps[0]).toHaveProperty("symbols");
  });

  it("should extract python imports", async () => {
    const result = await parseFile(path.join(TEST_DIR, "python.py"));
    const deps = findDependencies(result);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0]).toHaveProperty("module");
  });

  it("should extract rust imports", async () => {
    const result = await parseFile(path.join(TEST_DIR, "rust.rs"));
    const deps = findDependencies(result);
    expect(deps).toBeDefined();
    expect(Array.isArray(deps)).toBe(true);
  });

  it("should extract go imports", async () => {
    const result = await parseFile(path.join(TEST_DIR, "go.go"));
    const deps = findDependencies(result);
    expect(deps.some((d) => d.module.includes("fmt"))).toBe(true);
  });
});

describe("parseFile edge cases", () => {
  it("should handle JS file", async () => {
    const jsPath = path.join(TEST_DIR, "code.js");
    fs.writeFileSync(jsPath, "function add(a, b) { return a + b; }\nmodule.exports = { add };\n", "utf8");
    const result = await parseFile(jsPath);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should handle JSX file", async () => {
    const jsxPath = path.join(TEST_DIR, "Component.jsx");
    fs.writeFileSync(jsxPath, "export default function App() { return <div />; }\n", "utf8");
    const result = await parseFile(jsxPath);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should handle TSX file", async () => {
    const tsxPath = path.join(TEST_DIR, "Component.tsx");
    fs.writeFileSync(tsxPath, "export default function App(): JSX.Element { return <div />; }\n", "utf8");
    const result = await parseFile(tsxPath);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should handle empty file", async () => {
    const emptyPath = path.join(TEST_DIR, "empty.ts");
    fs.writeFileSync(emptyPath, "", "utf8");
    const result = await parseFile(emptyPath);
    expect(result.lineCount).toBeLessThanOrEqual(1);
    expect(result.symbols.length).toBe(0);
  });

  it("should handle file with only comments", async () => {
    const commentPath = path.join(TEST_DIR, "comments.ts");
    fs.writeFileSync(commentPath, "// just a comment\n/* block comment */\n", "utf8");
    const result = await parseFile(commentPath);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should detect class symbols", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    expect(result.symbols.some((s) => s.type === "class")).toBe(true);
  });

  it("should detect interface symbols", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    expect(result.symbols.some((s) => s.type === "interface")).toBe(true);
  });

  it("should detect type symbols", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    expect(result.symbols.some((s) => s.type === "type")).toBe(true);
  });
});

describe("findSymbol edge cases", () => {
  it("should find class symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "Calculator");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("class");
  });

  it("should find interface symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "User");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("interface");
  });
});

describe("parseSource edge cases", () => {
  it("should handle Python source", async () => {
    const result = await parseSource("def hello():\n    pass\n", "tree-sitter-python");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle Rust source", async () => {
    const result = await parseSource("pub fn add(a: i32, b: i32) -> i32 { a + b }\n", "tree-sitter-rust");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle Go source", async () => {
    const result = await parseSource("package main\nfunc main() {}\n", "tree-sitter-go");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle empty source", async () => {
    const result = await parseSource("", "tree-sitter-typescript");
    expect(result.symbols.length).toBe(0);
  });

  it("should handle malformed source", async () => {
    const result = await parseSource("function {{{ broken", "tree-sitter-typescript");
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should default to typescript when no language specified", async () => {
    const result = await parseSource("function foo() {}\n");
    expect(result.language).toBe("typescript");
    expect(result.symbols.some((s) => s.name === "foo")).toBe(true);
  });
});

describe("Java file parsing", () => {
  it("should parse Java file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "app.java"));
    expect(result.language).toBe("tree-sitter-java");
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols.some((s) => s.type === "class")).toBe(true);
  });

  it("should extract Java imports via tree-sitter", async () => {
    const result = await parseFile(path.join(TEST_DIR, "app.java"));
    expect(result.imports.length).toBeGreaterThan(0);
  });

  it("should parse Java file via fallback", async () => {
    const result = await parseSource(
      'import java.util.List;\nimport static java.lang.Math.PI;\npublic class App { public void run() {} }\ninterface Serializable {}\n',
      "java"
    );
    expect(result.language).toBe("java");
    expect(result.symbols.some((s) => s.name === "App")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Serializable")).toBe(true);
    expect(result.imports.some((d) => d.module.includes("java.util.List"))).toBe(true);
    expect(result.imports.some((d) => d.module.includes("java.lang.Math.PI"))).toBe(true);
    expect(result.exports.some((e) => e === "App")).toBe(true);
  });
});

describe("parseDirectory", () => {
  it("should parse all files in a directory", async () => {
    const result = await parseFile(TEST_DIR);
    expect(result.language).toBe("directory");
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);
  });

  it("should tag symbols with source file info", async () => {
    const result = await parseFile(TEST_DIR);
    const tagged = result.symbols.filter((s) => s.docstring);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0]!.docstring).toMatch(/\.(\w+):/);
  });
});

describe("extensionless files", () => {
  it("should handle extensionless file as typescript", async () => {
    const extPath = path.join(TEST_DIR, "Makefile");
    fs.writeFileSync(extPath, "function build() {}\n", "utf8");
    const result = await parseFile(extPath);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should handle unknown extension as typescript", async () => {
    const weirdPath = path.join(TEST_DIR, "config.xyz");
    fs.writeFileSync(weirdPath, "function hello() {}\n", "utf8");
    const result = await parseFile(weirdPath);
    expect(result.language).toBe("tree-sitter-typescript");
    expect(result.symbols.some((s) => s.name === "hello")).toBe(true);
  });
});

describe("parseSource with explicit language names", () => {
  it("should parse Python with 'python' language name", async () => {
    const result = await parseSource(
      "def hello():\n    pass\nfrom os import path\nimport sys\n",
      "python"
    );
    expect(result.language).toBe("python");
    expect(result.symbols.some((s) => s.name === "hello")).toBe(true);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it("should parse Rust with 'rust' language name", async () => {
    const result = await parseSource(
      "pub fn add(a: i32) -> i32 { a }\nstruct Point { x: f64 }\nenum Color { Red }\ntrait Drawable { fn draw(); }\nuse std::io::Read;\npub fn exported() {}\n",
      "rust"
    );
    expect(result.language).toBe("rust");
    expect(result.symbols.some((s) => s.name === "add")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Point")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Color")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Drawable")).toBe(true);
    expect(result.imports.some((d) => d.module.includes("std::io::Read"))).toBe(true);
    expect(result.exports.some((e) => e === "add" || e === "exported")).toBe(true);
  });

  it("should parse Go with 'go' language name", async () => {
    const result = await parseSource(
      'package main\nimport "fmt"\nimport v "strings"\nfunc main() {}\nfunc Exported() {}\ntype User struct { Name string }\ninterface Stringer { String() string }\n',
      "go"
    );
    expect(result.language).toBe("go");
    expect(result.symbols.some((s) => s.name === "main")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Exported")).toBe(true);
    expect(result.imports.some((d) => d.module === "fmt")).toBe(true);
    expect(result.imports.some((d) => d.module === "v")).toBe(true);
    expect(result.exports.some((e) => e === "Exported")).toBe(true);
  });

  it("should parse Java with 'java' language name", async () => {
    const result = await parseSource(
      'package com.example;\nimport java.util.List;\nimport static java.lang.Math.PI;\npublic class App { public void run() {} }\ninterface Serializable {}\n',
      "java"
    );
    expect(result.language).toBe("java");
    expect(result.symbols.some((s) => s.name === "App")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Serializable")).toBe(true);
    expect(result.imports.some((d) => d.module.includes("java.util.List"))).toBe(true);
    expect(result.imports.some((d) => d.module.includes("java.lang.Math.PI"))).toBe(true);
    expect(result.exports.some((e) => e === "App")).toBe(true);
  });
});

describe("classifySymbolType coverage", () => {
  it("should classify variable type for lines with '='", async () => {
    const result = await parseSource("const x = 1\nlet y = 2\n");
    const vars = result.symbols.filter((s) => s.type === "variable");
    expect(vars.length).toBeGreaterThan(0);
  });

  it("should classify enum as type", async () => {
    const result = await parseSource("enum Direction { Up, Down }\n", "rust");
    const enums = result.symbols.filter((s) => s.type === "type" && s.name === "Direction");
    expect(enums.length).toBe(1);
  });

  it("should classify trait as interface", async () => {
    const result = await parseSource("trait Drawable { fn draw(); }\n", "rust");
    const traits = result.symbols.filter((s) => s.type === "interface" && s.name === "Drawable");
    expect(traits.length).toBe(1);
  });

  it("should classify struct as class", async () => {
    const result = await parseSource("struct Point { x: f64 }\n", "rust");
    const structs = result.symbols.filter((s) => s.type === "class" && s.name === "Point");
    expect(structs.length).toBe(1);
  });

  it("should classify Java interface", async () => {
    const result = await parseSource("interface Serializable {}\n", "java");
    const ifaces = result.symbols.filter((s) => s.type === "interface" && s.name === "Serializable");
    expect(ifaces.length).toBe(1);
  });

  it("should classify Java class", async () => {
    const result = await parseSource("public class App {}\n", "java");
    const classes = result.symbols.filter((s) => s.type === "class" && s.name === "App");
    expect(classes.length).toBe(1);
  });

  it("should classify Python __all__ export", async () => {
    const result = await parseSource("__all__ = ['hello', 'world']\ndef hello(): pass\n", "python");
    expect(result.exports.length).toBeGreaterThan(0);
  });

  it("should classify Go type struct", async () => {
    const result = await parseSource("type User struct { Name string }\n", "go");
    const structs = result.symbols.filter((s) => s.name === "User");
    expect(structs.length).toBe(1);
    expect(structs[0]!.type).toBe("type");
  });

  it("should classify Go type interface", async () => {
    const result = await parseSource("type Stringer interface { String() string }\n", "go");
    const ifaces = result.symbols.filter((s) => s.type === "interface" && s.name === "Stringer");
    expect(ifaces.length).toBe(1);
  });

  it("should classify Go exported function", async () => {
    const result = await parseSource("func Exported() {}\n", "go");
    expect(result.exports.some((e) => e === "Exported")).toBe(true);
  });

  it("should classify Go method with receiver", async () => {
    const result = await parseSource("func (u *User) GetName() string { return u.name }\n", "go");
    expect(result.symbols.some((s) => s.name === "GetName")).toBe(true);
  });

  it("should classify Python class", async () => {
    const result = await parseSource("class MyClass:\n    pass\n", "python");
    const classes = result.symbols.filter((s) => s.type === "class" && s.name === "MyClass");
    expect(classes.length).toBe(1);
  });

  it("should classify Python function", async () => {
    const result = await parseSource("def my_func():\n    pass\n", "python");
    const funcs = result.symbols.filter((s) => s.type === "function" && s.name === "my_func");
    expect(funcs.length).toBe(1);
  });

  it("should classify Rust public function as exported", async () => {
    const result = await parseSource("pub fn add(a: i32) -> i32 { a }\n", "rust");
    expect(result.symbols.some((s) => s.name === "add" && s.exported)).toBe(true);
  });

  it("should classify Java method", async () => {
    const result = await parseSource("public void run() {}\n", "java");
    const funcs = result.symbols.filter((s) => s.type === "function");
    expect(funcs.some((s) => s.name === "run")).toBe(true);
  });
});

describe("findSymbol with different types", () => {
  it("should find enum symbol in Rust", async () => {
    const result = await parseSource("enum Color { Red, Green, Blue }\n", "rust");
    const symbol = findSymbol(result, "Color");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("type");
  });

  it("should find trait symbol in Rust", async () => {
    const result = await parseSource("trait Drawable { fn draw(); }\n", "rust");
    const symbol = findSymbol(result, "Drawable");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("interface");
  });

  it("should find struct symbol in Go via fallback", async () => {
    const result = await parseSource("type User struct { Name string }\n", "go");
    const symbol = findSymbol(result, "User");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("type");
  });

  it("should find interface symbol in Go via fallback", async () => {
    const result = await parseSource("type Stringer interface { String() string }\n", "go");
    const symbol = findSymbol(result, "Stringer");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("interface");
  });

  it("should find variable symbol", async () => {
    const result = await parseSource("const internal = 42\n");
    const symbol = findSymbol(result, "internal");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("variable");
  });
});

describe("deeply nested imports", () => {
  it("should handle TypeScript type-only imports", async () => {
    const result = await parseSource(
      'import type { Readable } from "stream";\nimport { readFileSync } from "fs";\n',
      "tree-sitter-typescript"
    );
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle Python from-import with alias", async () => {
    const result = await parseSource(
      "from os.path import join as pjoin\nimport sys as system\n",
      "python"
    );
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle Rust nested use paths", async () => {
    const result = await parseSource(
      "use std::collections::HashMap;\nuse crate::module::{Item, Helper};\n",
      "rust"
    );
    expect(result.imports.some((d) => d.module.includes("std::collections::HashMap"))).toBe(true);
  });

  it("should handle Go aliased imports", async () => {
    const result = await parseSource(
      'import v "strings"\nimport "fmt"\n',
      "go"
    );
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.some((d) => d.module === "fmt")).toBe(true);
    expect(result.imports.some((d) => d.module === "v")).toBe(true);
  });

  it("should handle deeply nested module paths", async () => {
    const result = await parseSource(
      'import { deep } from "@scope/deeply/nested/module/path";\n',
      "tree-sitter-typescript"
    );
    expect(result.imports.some((d) => d.module.includes("@scope/deeply/nested/module/path"))).toBe(true);
  });
});

describe("parseFile error handling", () => {
  it("should handle non-existent file gracefully", async () => {
    const result = await parseFile(path.join(TEST_DIR, "nonexistent.xyz"));
    expect(result.lineCount).toBe(0);
    expect(result.language).toBe("unknown");
  });
});

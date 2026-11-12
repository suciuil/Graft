/**
 * Files the parser could not read whole. The build records, on a file's node,
 * how many places of it were syntax errors in the parse its symbols came from
 * (`NodeV1.parse_errors`). Symbols, calls and spans in such a file may be
 * missing or cut short, so every reader that shows something from one says so,
 * and an assistant knows its answer may be incomplete there.
 */
import type { GraphV1 } from "./types.js";

const byGraph = new WeakMap<object, Map<string, number>>();

/** Path → syntax-error count, for the files of `graph` that have any. Computed
 * once per loaded graph. */
export function parseErrorFiles(graph: Pick<GraphV1, "nodes">): Map<string, number> {
  let files = byGraph.get(graph);
  if (!files) {
    files = new Map();
    for (const n of graph.nodes) if (n.kind === "file" && n.parse_errors) files.set(n.path, n.parse_errors);
    byGraph.set(graph, files);
  }
  return files;
}

/** Syntax errors in the file at `path`, or 0. */
export function parseErrorsOf(graph: Pick<GraphV1, "nodes"> | null | undefined, path: string): number {
  return graph ? (parseErrorFiles(graph).get(path) ?? 0) : 0;
}

/** The repo-relative path of a `file` or `file:Lx-Ly` pointer. */
export function pointerPath(pointer: string): string {
  return pointer.replace(/:L\d+(?:-L\d+)?$/, "");
}

/** The warning printed next to anything from a file with `count` syntax errors. */
export function parseErrorWarning(count: number): string {
  const what = count === 1 ? "1 syntax error" : `${count} syntax errors`;
  return `⚠ parsed with ${what}: symbols, calls or spans in this file may be missing or incomplete`;
}

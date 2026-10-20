// Preloaded (NODE_OPTIONS --require) into the node process `tree-sitter generate`
// spawns to evaluate grammar.js. Older CLIs (e.g. 0.22) on Windows pass the grammar as
// a Rust-canonicalized verbatim path (`\\?\D:\...`), which recent Node `require()`
// rejects with `EISDIR: illegal operation on a directory, lstat 'D:'`. Hand it the
// plain path instead.
const key = "TREE_SITTER_GRAMMAR_PATH";
const value = process.env[key];
if (value) {
  if (value.startsWith("\\\\?\\UNC\\")) process.env[key] = `\\\\${value.slice(8)}`;
  else if (value.startsWith("\\\\?\\")) process.env[key] = value.slice(4);
}

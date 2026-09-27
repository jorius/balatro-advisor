import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLuaTable } from '../src/save/lua-table.js';

test('parses scalars, strings and nested tables', () => {
  const v = parseLuaTable('return {["a"]=1,["b"]="x",["c"]=true,["d"]=false,["e"]={["f"]=-2.5,},}');
  assert.deepEqual(v, { a: 1, b: 'x', c: true, d: false, e: { f: -2.5 } });
});

test('tables keyed 1..n become arrays regardless of entry order', () => {
  const v = parseLuaTable('return {[2]="b",[1]="a",[3]="c",}');
  assert.deepEqual(v, ['a', 'b', 'c']);
});

test('sparse or mixed tables stay objects; empty table is an empty array', () => {
  assert.deepEqual(parseLuaTable('return {[1]="a",[3]="c",}'), { 1: 'a', 3: 'c' });
  assert.deepEqual(parseLuaTable('return {[1]="a",["k"]=2,}'), { 1: 'a', k: 2 });
  assert.deepEqual(parseLuaTable('return {}'), []);
});

test('handles %q string escapes', () => {
  const v = parseLuaTable('return {["s"]="q\\"uote \\\\ back\\\nnl \\065 tab\\t",}');
  assert.equal(v.s, 'q"uote \\ back\nnl A tab\t');
});

test('handles exponent, inf and nan numbers', () => {
  const v = parseLuaTable('return {["a"]=1e+15,["b"]=inf,["c"]=-inf,["d"]=nan,["e"]=-nan(ind),["f"]=1.#INF,["g"]=-1.#IND,}');
  assert.equal(v.a, 1e15);
  assert.equal(v.b, Infinity);
  assert.equal(v.c, -Infinity);
  assert.ok(Number.isNaN(v.d));
  assert.ok(Number.isNaN(v.e));
  assert.equal(v.f, Infinity);
  assert.ok(Number.isNaN(v.g));
});

test('works without the return prefix and tolerates whitespace', () => {
  assert.deepEqual(parseLuaTable('  { ["a"] = { [1] = 1 , [2] = 2 } }  '), { a: [1, 2] });
});

test('throws on malformed input', () => {
  assert.throws(() => parseLuaTable('return {["a"]=1'), /expected/);
  assert.throws(() => parseLuaTable('return {["a"]=@,}'), /number|unexpected/i);
});
